import PizZip from 'pizzip';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function xmlEscapeText(value) {
  return String(value ?? '');
}

function elementChildrenByLocalName(node, localName) {
  return Array.from(node?.childNodes || []).filter(n => n.nodeType === 1 && n.localName === localName);
}

function getTopLevelTables(doc) {
  const body = Array.from(doc.getElementsByTagNameNS(W_NS, 'body'))[0];
  return elementChildrenByLocalName(body, 'tbl');
}

function tableRows(table) {
  return elementChildrenByLocalName(table, 'tr');
}

function rowCells(row) {
  return elementChildrenByLocalName(row, 'tc');
}

function setNodeTextPreserve(node, value) {
  if (!node) return;
  const texts = Array.from(node.getElementsByTagNameNS(W_NS, 't'));
  const text = xmlEscapeText(value);
  if (texts.length) {
    texts[0].textContent = text;
    if (/^\s|\s$/.test(text)) texts[0].setAttribute('xml:space', 'preserve');
    else texts[0].removeAttribute('xml:space');
    texts.slice(1).forEach(t => { t.textContent = ''; });
    return;
  }
  let p = Array.from(node.getElementsByTagNameNS(W_NS, 'p'))[0];
  if (!p) {
    p = node.ownerDocument.createElementNS(W_NS, 'w:p');
    node.appendChild(p);
  }
  const r = node.ownerDocument.createElementNS(W_NS, 'w:r');
  const t = node.ownerDocument.createElementNS(W_NS, 'w:t');
  t.textContent = text;
  r.appendChild(t);
  p.appendChild(r);
}

function setCell(tables, tableIndex, rowIndex, cellIndex, value) {
  const table = tables[tableIndex];
  const row = tableRows(table)[rowIndex];
  const cell = rowCells(row)[cellIndex];
  setNodeTextPreserve(cell, value);
}

function replaceMarkers(doc, values) {
  const texts = Array.from(doc.getElementsByTagNameNS(W_NS, 't'));
  for (const t of texts) {
    let value = t.textContent || '';
    let changed = false;
    for (const [marker, replacement] of Object.entries(values)) {
      if (value.includes(marker)) {
        value = value.split(marker).join(String(replacement ?? ''));
        changed = true;
      }
    }
    if (changed) t.textContent = value;
  }
}


function resizeTableDataRows(table, dataRowCount) {
  const rows = tableRows(table);
  if (rows.length < 2) return;
  const template = rows[1].cloneNode(true);
  rows.slice(1).forEach(r => r.parentNode.removeChild(r));
  const count = Math.max(1, Number(dataRowCount) || 0);
  for (let i = 0; i < count; i++) table.appendChild(template.cloneNode(true));
}

function setTableCell(table, rowIndex, cellIndex, value) {
  const row = tableRows(table)[rowIndex];
  const cell = row ? rowCells(row)[cellIndex] : null;
  setNodeTextPreserve(cell, value);
}

function compactTableCellParagraphs(table, rowIndex, cellIndex) {
  const row = tableRows(table)[rowIndex];
  const cell = row ? rowCells(row)[cellIndex] : null;
  if (!cell) return;

  const paragraphs = Array.from(cell.children).filter(n => n.namespaceURI === W_NS && n.localName === 'p');
  paragraphs.slice(1).forEach(p => cell.removeChild(p));
}

function removeTableRowMinimumHeights(table) {
  for (const row of tableRows(table)) {
    const rowPr = Array.from(row.children).find(n => n.namespaceURI === W_NS && n.localName === 'trPr');
    if (!rowPr) continue;
    Array.from(rowPr.children)
      .filter(n => n.namespaceURI === W_NS && n.localName === 'trHeight')
      .forEach(n => rowPr.removeChild(n));
  }
}

function cleanSection7SpacerParagraphs(doc) {
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) return;

  const children = () => Array.from(body.children);
  const isParagraph = n => n?.namespaceURI === W_NS && n?.localName === 'p';
  const paragraphText = n => Array.from(n.getElementsByTagNameNS(W_NS, 't'))
    .map(t => t.textContent || '').join('').trim();

  const note = children().find(n => isParagraph(n) && paragraphText(n).startsWith('Nota:'));
  if (!note) return;

  // Remove empty spacer paragraphs immediately before the institutional note.
  while (true) {
    const current = children();
    const idx = current.indexOf(note);
    const prev = idx > 0 ? current[idx - 1] : null;
    if (!isParagraph(prev) || paragraphText(prev)) break;
    body.removeChild(prev);
  }

  // Remove trailing empty paragraphs after the note. They create a blank final page
  // once the number of justification blocks becomes dynamic.
  while (true) {
    const current = children();
    const idx = current.indexOf(note);
    const next = idx >= 0 ? current[idx + 1] : null;
    if (!isParagraph(next) || paragraphText(next)) break;
    body.removeChild(next);
  }
}

function resizeJustificationTables(doc, tables, count) {
  const base = tables[27];
  const existing = tables.slice(27, 40);
  if (!base || !existing.length) return [];
  const target = Math.max(1, Number(count) || 0);
  if (target <= existing.length) {
    existing.slice(target).forEach(t => t.parentNode?.removeChild(t));
    return existing.slice(0, target);
  }
  const out = [...existing];
  let anchor = existing.at(-1);
  for (let i = existing.length; i < target; i++) {
    const clone = base.cloneNode(true);
    anchor.parentNode.insertBefore(clone, anchor.nextSibling);
    anchor = clone;
    out.push(clone);
  }
  return out;
}

function fechaLocal(iso, { larga = false } = {}) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  if (larga) {
    return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'long', year: 'numeric' })
      .format(d)
      .replace(/^(\d{2}) de /, '$1 de ');
  }
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

function fechaGuion(iso) {
  return fechaLocal(iso).replaceAll('/', '-');
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function jornadaTexto(practica) {
  if (practica?.modalidadPermanencia === 'sin_permanencia') return 'SIN PERMANENCIA PRESENCIAL';
  const dias = (practica?.diasPermanencia || []).map(n => DIAS[Number(n)]).filter(Boolean);
  const diasTxt = dias.length === 1
    ? dias[0]
    : dias.length === 2
      ? `${dias[0]} y ${dias[1]}`
      : dias.length > 2 ? `${dias.slice(0, -1).join(', ')} y ${dias.at(-1)}` : '';
  const hora = practica?.permanenciaHoraInicio && practica?.permanenciaHoraTermino
    ? ` de ${practica.permanenciaHoraInicio} a ${practica.permanenciaHoraTermino} horas`
    : '';
  return `${diasTxt}${hora}`.trim().toUpperCase();
}

function isoDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function mesesEntre(inicioIso, terminoIso) {
  if (!inicioIso || !terminoIso) return [];
  const ini = new Date(`${inicioIso}T12:00:00`);
  const fin = new Date(`${terminoIso}T12:00:00`);
  const out = [];
  let y = ini.getFullYear(), m = ini.getMonth();
  while (y < fin.getFullYear() || (y === fin.getFullYear() && m <= fin.getMonth())) {
    out.push({ y, m });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out.slice(0, 7);
}

function asistenciaEfectiva(fecha, practica, mapa) {
  const explicita = mapa.get(fecha);
  if (explicita) return explicita.estado || '';
  if (practica?.modalidadPermanencia !== 'presencial') return '';
  const d = new Date(`${fecha}T12:00:00`);
  return (practica?.diasPermanencia || []).includes(d.getDay()) ? 'X' : '';
}

function prepararAsistencia(practica, registros) {
  const mapa = new Map((registros || []).map(r => [r.fecha, r]));
  const meses = mesesEntre(practica?.fechaInicio, practica?.fechaTermino);
  const filas = [];
  let justificadas = 0, injustificadas = 0, recuperados = 0;
  const ini = practica?.fechaInicio || '';
  const fin = practica?.fechaTermino || '';

  for (const { y, m } of meses) {
    const valores = Array(31).fill('');
    const ultimo = new Date(y, m + 1, 0, 12).getDate();
    for (let dia = 1; dia <= ultimo; dia++) {
      const fecha = isoDate(y, m, dia);
      if (fecha < ini || fecha > fin) continue;
      const estado = asistenciaEfectiva(fecha, practica, mapa);
      if (estado === 'L') justificadas++;
      if (estado === 'O') injustificadas++;
      if (estado === 'R') recuperados++;
      valores[dia - 1] = estado === 'R' ? 'X' : estado;
    }
    const mes = new Intl.DateTimeFormat('es-CL', { month: 'long' }).format(new Date(y, m, 1, 12)).toUpperCase();
    filas.push({ mes, valores });
  }
  return { filas, justificadas, injustificadas, recuperados };
}

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function estadisticasCausas(causas) {
  const nuevas = causas.filter(c => c.origenCarpeta === 'Nueva').length;
  const traspasadas = causas.filter(c => c.origenCarpeta === 'Traspasada').length;
  const total = causas.length;
  const terminadas = causas.filter(c => c.categoria === 'terminada').length;
  const extrajudiciales = causas.filter(c => normalizar(c.subcategoria).includes('extrajudicial')).length;
  return { nuevas, traspasadas, total, terminadas, extrajudiciales };
}

function corteOficial(valor) {
  const v = String(valor || '');
  if (v === 'C.A de Santiago') return 'SANTIAGO';
  if (v === 'C.A de San Miguel') return 'SAN MIGUEL';
  if (v === 'C.S de Santiago') return 'CORTE SUPREMA';
  return v.toUpperCase();
}

function numeroEnPalabras(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return 'CERO';
  const unidades = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
  const dec = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const cen = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
  const menorMil = x => {
    if (x === 100) return 'CIEN';
    if (x < 30) return unidades[x];
    if (x < 100) return `${dec[Math.floor(x / 10)]}${x % 10 ? ' Y ' + unidades[x % 10] : ''}`;
    return `${cen[Math.floor(x / 100)]}${x % 100 ? ' ' + menorMil(x % 100) : ''}`;
  };
  if (n < 1000) return menorMil(n);
  if (n < 1_000_000) {
    const miles = Math.floor(n / 1000), resto = n % 1000;
    return `${miles === 1 ? 'MIL' : menorMil(miles) + ' MIL'}${resto ? ' ' + menorMil(resto) : ''}`;
  }
  if (n < 1_000_000_000) {
    const mill = Math.floor(n / 1_000_000), resto = n % 1_000_000;
    const pref = mill === 1 ? 'UN MILLÓN' : `${numeroEnPalabras(mill)} MILLONES`;
    return `${pref}${resto ? ' ' + numeroEnPalabras(resto) : ''}`;
  }
  return String(n);
}

function descargarBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function nombreArchivo(postulante) {
  const limpio = String(postulante || 'Postulante')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `Formulario_N10_PreEvaluacion_${limpio}.docx`;
}

export async function generarFormulario10Docx(datos) {
  const resp = await fetch('/templates/formulario-10-pre-evaluacion.docx');
  if (!resp.ok) throw new Error('No se pudo cargar la plantilla institucional del Formulario N°10.');
  const zip = new PizZip(await resp.arrayBuffer());
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('La plantilla DOCX no contiene word/document.xml.');
  const xml = xmlFile.asText();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('No se pudo interpretar la plantilla DOCX.');
  const tables = getTopLevelTables(doc);
  if (tables.length < 40) throw new Error('La plantilla institucional no tiene la estructura esperada.');

  const practica = datos.practica || {};
  const asistencia = prepararAsistencia(practica, datos.asistencia || []);
  const stats = estadisticasCausas(datos.causas || []);
  const monto = practica.honorariosCostas === true ? Number(practica.honorariosCostasMonto || 0) : 0;
  const unidad = datos.unidad || '';

  replaceMarkers(doc, {
    '[[POSTULANTE]]': datos.postulante || '',
    '[[RUN]]': datos.rut || '',
    '[[UNIDAD]]': unidad,
    '[[ABOGADO_JEFE]]': datos.abogadoJefe || '',
    '[[TUTORES]]': (datos.tutores || []).join(', '),
    '[[INICIO]]': fechaLocal(practica.fechaInicio, { larga: true }),
    '[[TERMINO]]': fechaLocal(practica.fechaTermino, { larga: true }),
    '[[TERMINO_PROVISIONAL]]': '',
    '[[APERCIBIMIENTO]]': practica.apercibimiento === true
      ? `SI${practica.apercibimientoFecha ? ', ' + fechaLocal(practica.apercibimientoFecha) : ''}`
      : practica.apercibimiento === false ? 'NO' : '',
    '[[FECHA_CARPETAS]]': fechaLocal(practica.fechaEntregaCarpetasRevision, { larga: true }),
    '[[FECHA_INFORME]]': fechaLocal(practica.fechaEntregaInformeFinal, { larga: true }),
    '[[FECHA_PREINFORME]]': fechaLocal(practica.fechaEntregaPreinformeTutor, { larga: true }),
    '[[FECHA_COMUNICACION]]': fechaLocal(practica.fechaComunicacionPropuestaEvaluacion, { larga: true }),
    '[[JORNADA]]': jornadaTexto(practica),
    '[[INASIST_JUST]]': asistencia.justificadas,
    '[[INASIST_INJUST]]': asistencia.injustificadas,
    '[[DIAS_RECUP]]': asistencia.recuperados,
    '[[REVISION_1]]': fechaGuion(practica.revisionIntermedia1),
    '[[REVISION_2]]': fechaGuion(practica.revisionIntermedia2),
    '[[HONORARIOS_MONTO]]': monto.toLocaleString('es-CL'),
    '[[HONORARIOS_MONTO_PALABRAS]]': numeroEnPalabras(monto),
    '[[POSTULANTE_EVALUACION]]': datos.postulante || '',
    '[[UNIDAD_EVALUACION]]': unidad,
    '[[TIPO_JUSTIFICACION]]': datos.justificacion?.aplica === true
      ? (datos.justificacion?.tipo === 'deficiente' ? 'deficiente' : 'destacada')
      : 'destacada/deficiente'
  });

  // 2.1 Asistencia mensual.
  for (let r = 1; r <= 7; r++) {
    const fila = asistencia.filas[r - 1];
    setCell(tables, 4, r, 0, fila?.mes || '');
    for (let c = 1; c <= 31; c++) setCell(tables, 4, r, c, fila?.valores[c - 1] || '');
  }

  // 2.2 Estadística de causas: esta aplicación corresponde al área Civil.
  for (let r = 1; r <= 5; r++) for (let c = 1; c <= 4; c++) setCell(tables, 5, r, c, '0');
  setCell(tables, 5, 2, 1, stats.nuevas);
  setCell(tables, 5, 2, 2, stats.traspasadas);
  setCell(tables, 5, 2, 3, stats.total);
  setCell(tables, 5, 2, 4, stats.terminadas);
  setCell(tables, 5, 6, 1, stats.nuevas);
  setCell(tables, 5, 6, 2, stats.traspasadas);
  setCell(tables, 5, 6, 3, stats.total);
  setCell(tables, 5, 6, 4, stats.terminadas);
  setCell(tables, 5, 8, 1, stats.extrajudiciales);

  // 2.3 Apercibimientos: la X siempre queda dentro del recuadro correspondiente.
  setCell(tables, 7, 0, 0, 'SI');
  setCell(tables, 7, 0, 1, practica.apercibimiento === true ? 'X' : '');
  setCell(tables, 7, 0, 2, 'NO');
  setCell(tables, 7, 0, 3, practica.apercibimiento === false ? 'X' : '');

  // 2.5 Honorarios/costas.
  setCell(tables, 8, 0, 0, 'SI');
  setCell(tables, 8, 0, 1, practica.honorariosCostas === true ? 'X' : '');
  setCell(tables, 8, 0, 2, 'NO');
  setCell(tables, 8, 0, 3, practica.honorariosCostas === false ? 'X' : '');

  // 2.5 Habilitación de audiencias: se alimenta de Agenda y usa solo audiencias realizadas.
  {
    const audiencias = Array.isArray(datos.audiencias) ? datos.audiencias : [];
    resizeTableDataRows(tables[9], audiencias.length || 1);
    for (let r = 1; r < tableRows(tables[9]).length; r++) {
      const a = audiencias[r - 1];
      setTableCell(tables[9], r, 0, a?.tipoAudiencia || '');
      setTableCell(tables[9], r, 1, fechaLocal(a?.fecha));
      setTableCell(tables[9], r, 2, a?.rit || '');
      setTableCell(tables[9], r, 3, String(a?.materia || '').toUpperCase());
      setTableCell(tables[9], r, 4, String(a?.tribunal || '').toUpperCase());
    }
  }

  // 2.6 Comparecencia a alegatos.
  const alegatos = [...(datos.alegatosPropios || []), ...(datos.alegatosOyente || [])]
    .sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
  for (let r = 1; r < tableRows(tables[10]).length; r++) {
    const a = alegatos[r - 1];
    setCell(tables, 10, r, 0, a ? r : '');
    setCell(tables, 10, r, 1, a?.nicRol || '');
    setCell(tables, 10, r, 2, corteOficial(a?.corte));
    setCell(tables, 10, r, 3, String(a?.materia || '').toUpperCase());
    setCell(tables, 10, r, 4, fechaGuion(a?.fecha));
    setCell(tables, 10, r, 5, a ? String(a.participacion || 'OYENTE').toUpperCase() : '');
  }

  // 7. Justificación sobresaliente / deficiente.
  // Si no corresponde, se conserva íntegramente la sección institucional en blanco.
  // Si corresponde, se ajusta la cantidad de bloques al número de causas elegidas.
  if (datos.justificacion?.aplica === true) {
    const seleccionadas = Array.isArray(datos.justificacion?.causas) ? datos.justificacion.causas : [];
    const bloques = resizeJustificationTables(doc, tables, seleccionadas.length || 1);
    bloques.forEach((tabla, i) => {
      const c = seleccionadas[i];
      setTableCell(tabla, 0, 1, c?.rol || '');
      setTableCell(tabla, 1, 1, c?.tribunal || '');
      setTableCell(tabla, 2, 1, c?.materia || '');
      setTableCell(tabla, 3, 1, c?.gestion || '');

      // Los bloques del modelo traen numerosos párrafos vacíos para dejar espacio
      // de escritura manual. En el DOCX generado el alto debe adaptarse al texto real.
      compactTableCellParagraphs(tabla, 3, 1);
      removeTableRowMinimumHeights(tabla);
    });
    cleanSection7SpacerParagraphs(doc);
  } else {
    for (let i = 27; i <= 39; i++) {
      const tabla = tables[i];
      if (!tabla) continue;
      for (let r = 0; r < tableRows(tabla).length; r++) setTableCell(tabla, r, 1, '');
    }
  }

  const serialized = new XMLSerializer().serializeToString(doc);
  zip.file('word/document.xml', serialized);
  const blob = zip.generate({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
  descargarBlob(blob, nombreArchivo(datos.postulante));
}
