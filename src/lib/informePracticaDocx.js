import PizZip from 'pizzip';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function childrenByLocalName(node, localName) {
  return Array.from(node?.childNodes || []).filter(n => n.nodeType === 1 && n.localName === localName);
}

function bodyNode(doc) {
  return Array.from(doc.getElementsByTagNameNS(W_NS, 'body'))[0] || null;
}

function topLevelTables(doc) {
  return childrenByLocalName(bodyNode(doc), 'tbl');
}

function tableRows(table) {
  return childrenByLocalName(table, 'tr');
}

function rowCells(row) {
  return childrenByLocalName(row, 'tc');
}

function textOf(node) {
  return Array.from(node?.getElementsByTagNameNS(W_NS, 't') || []).map(t => t.textContent || '').join('');
}

function createRun(doc, text, { bold = false, size = '18', font = 'Verdana' } = {}) {
  const r = doc.createElementNS(W_NS, 'w:r');
  const rPr = doc.createElementNS(W_NS, 'w:rPr');
  const rFonts = doc.createElementNS(W_NS, 'w:rFonts');
  rFonts.setAttributeNS(W_NS, 'w:ascii', font);
  rFonts.setAttributeNS(W_NS, 'w:hAnsi', font);
  rFonts.setAttributeNS(W_NS, 'w:eastAsia', font);
  rFonts.setAttributeNS(W_NS, 'w:cs', font);
  rPr.appendChild(rFonts);
  if (bold) {
    rPr.appendChild(doc.createElementNS(W_NS, 'w:b'));
    rPr.appendChild(doc.createElementNS(W_NS, 'w:bCs'));
  }
  const sz = doc.createElementNS(W_NS, 'w:sz');
  sz.setAttributeNS(W_NS, 'w:val', size);
  const szCs = doc.createElementNS(W_NS, 'w:szCs');
  szCs.setAttributeNS(W_NS, 'w:val', size);
  rPr.appendChild(sz);
  rPr.appendChild(szCs);
  r.appendChild(rPr);
  const t = doc.createElementNS(W_NS, 'w:t');
  if (/^\s|\s$/.test(text)) t.setAttribute('xml:space', 'preserve');
  t.textContent = text;
  r.appendChild(t);
  return r;
}

function ensureRunFormatting(run, { bold = false, size = '18', font = 'Verdana' } = {}) {
  if (!run) return;
  const doc = run.ownerDocument;
  let rPr = childrenByLocalName(run, 'rPr')[0];
  if (!rPr) {
    rPr = doc.createElementNS(W_NS, 'w:rPr');
    run.insertBefore(rPr, run.firstChild);
  }

  let rFonts = childrenByLocalName(rPr, 'rFonts')[0];
  if (!rFonts) {
    rFonts = doc.createElementNS(W_NS, 'w:rFonts');
    rPr.insertBefore(rFonts, rPr.firstChild);
  }
  ['ascii', 'hAnsi', 'eastAsia', 'cs'].forEach(attr => rFonts.setAttributeNS(W_NS, `w:${attr}`, font));

  childrenByLocalName(rPr, 'b').forEach(x => rPr.removeChild(x));
  childrenByLocalName(rPr, 'bCs').forEach(x => rPr.removeChild(x));
  if (bold) {
    rPr.appendChild(doc.createElementNS(W_NS, 'w:b'));
    rPr.appendChild(doc.createElementNS(W_NS, 'w:bCs'));
  }

  let sz = childrenByLocalName(rPr, 'sz')[0];
  if (!sz) { sz = doc.createElementNS(W_NS, 'w:sz'); rPr.appendChild(sz); }
  sz.setAttributeNS(W_NS, 'w:val', size);
  let szCs = childrenByLocalName(rPr, 'szCs')[0];
  if (!szCs) { szCs = doc.createElementNS(W_NS, 'w:szCs'); rPr.appendChild(szCs); }
  szCs.setAttributeNS(W_NS, 'w:val', size);
}

function formatParagraph(paragraph, options = {}) {
  Array.from(paragraph?.getElementsByTagNameNS(W_NS, 'r') || []).forEach(r => ensureRunFormatting(r, options));
}

function setParagraphIndent(paragraph, left = '154', right = '139') {
  if (!paragraph) return;
  const doc = paragraph.ownerDocument;
  let pPr = childrenByLocalName(paragraph, 'pPr')[0];
  if (!pPr) {
    pPr = doc.createElementNS(W_NS, 'w:pPr');
    paragraph.insertBefore(pPr, paragraph.firstChild);
  }
  let ind = childrenByLocalName(pPr, 'ind')[0];
  if (!ind) {
    ind = doc.createElementNS(W_NS, 'w:ind');
    pPr.appendChild(ind);
  }
  ind.setAttributeNS(W_NS, 'w:left', left);
  ind.setAttributeNS(W_NS, 'w:right', right);
}

function setParagraphText(paragraph, text, options = {}) {
  if (!paragraph) return;
  Array.from(paragraph.childNodes).forEach(ch => {
    if (!(ch.nodeType === 1 && ch.localName === 'pPr')) paragraph.removeChild(ch);
  });
  paragraph.appendChild(createRun(paragraph.ownerDocument, String(text ?? ''), options));
}

function setParagraphLines(paragraph, lines = [], options = {}) {
  if (!paragraph) return;
  Array.from(paragraph.childNodes).forEach(ch => {
    if (!(ch.nodeType === 1 && ch.localName === 'pPr')) paragraph.removeChild(ch);
  });
  lines.forEach((line, index) => {
    paragraph.appendChild(createRun(paragraph.ownerDocument, String(line ?? ''), options));
    if (index < lines.length - 1) {
      const brRun = paragraph.ownerDocument.createElementNS(W_NS, 'w:r');
      brRun.appendChild(paragraph.ownerDocument.createElementNS(W_NS, 'w:br'));
      paragraph.appendChild(brRun);
    }
  });
}

function paragraphWithSameProperties(templateParagraph, text, options = {}) {
  const p = templateParagraph.cloneNode(true);
  Array.from(p.childNodes).forEach(ch => {
    if (!(ch.nodeType === 1 && ch.localName === 'pPr')) p.removeChild(ch);
  });
  p.appendChild(createRun(p.ownerDocument, text, options));
  return p;
}

function setNodeTextPreserve(node, value) {
  if (!node) return;
  const text = String(value ?? '');
  const texts = Array.from(node.getElementsByTagNameNS(W_NS, 't'));
  if (texts.length) {
    texts[0].textContent = text;
    if (/^\s|\s$/.test(text)) texts[0].setAttribute('xml:space', 'preserve');
    else texts[0].removeAttribute('xml:space');
    texts.slice(1).forEach(t => { t.textContent = ''; });
    return;
  }

  let p = node.localName === 'p' ? node : Array.from(node.getElementsByTagNameNS(W_NS, 'p'))[0];
  if (!p) {
    p = node.ownerDocument.createElementNS(W_NS, 'w:p');
    node.appendChild(p);
  }
  p.appendChild(createRun(node.ownerDocument, text, { size: '18' }));
}

function replaceParagraphMarker(doc, marker, value) {
  const body = bodyNode(doc);
  for (const p of childrenByLocalName(body, 'p')) {
    const current = textOf(p);
    if (!current.includes(marker)) continue;
    setNodeTextPreserve(p, current.replace(marker, String(value ?? '')));
    return true;
  }
  return false;
}

function setTableCell(table, rowIndex, cellIndex, value) {
  const row = tableRows(table)[rowIndex];
  const cell = row ? rowCells(row)[cellIndex] : null;
  setNodeTextPreserve(cell, value);
}

function removeNarrativeMinimumHeight(table) {
  const row = tableRows(table)[4];
  if (!row) return;
  const trPr = childrenByLocalName(row, 'trPr')[0];
  if (!trPr) return;
  childrenByLocalName(trPr, 'trHeight').forEach(h => trPr.removeChild(h));
}

function removePageBreakBeforeFromTable(table) {
  const firstRow = tableRows(table)[0];
  const firstCell = firstRow ? rowCells(firstRow)[0] : null;
  const p = firstCell ? childrenByLocalName(firstCell, 'p')[0] : null;
  const pPr = p ? childrenByLocalName(p, 'pPr')[0] : null;
  if (!pPr) return;
  childrenByLocalName(pPr, 'pageBreakBefore').forEach(x => pPr.removeChild(x));
}

function clearCellKeepProperties(cell) {
  Array.from(cell?.childNodes || []).forEach(ch => {
    if (!(ch.nodeType === 1 && ch.localName === 'tcPr')) cell.removeChild(ch);
  });
}

function paragraphFromTemplate(template, { fecha = '', descripcion = '', plain = '' } = {}) {
  const p = template.cloneNode(true);
  Array.from(p.childNodes).forEach(ch => {
    if (!(ch.nodeType === 1 && ch.localName === 'pPr')) p.removeChild(ch);
  });

  const doc = p.ownerDocument;
  if (plain) {
    p.appendChild(createRun(doc, plain, { size: '18' }));
    return p;
  }
  p.appendChild(createRun(doc, fecha, { bold: true, size: '18' }));
  p.appendChild(createRun(doc, `. ${descripcion}`, { size: '18' }));
  return p;
}

function fechaInformeLarga(valor) {
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  let y, m, d;
  if (valor && /^\d{4}-\d{2}-\d{2}/.test(String(valor))) {
    [y, m, d] = String(valor).slice(0, 10).split('-').map(Number);
  } else {
    const hoy = new Date();
    y = hoy.getFullYear(); m = hoy.getMonth() + 1; d = hoy.getDate();
  }
  return `${d} de ${meses[m - 1]} de ${y}`;
}

function fechaGestion(valor) {
  const s = String(valor || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y,m,d] = s.split('-');
  return `${d}-${m}-${y}`;
}

function normalizarCaj(caj) {
  return String(caj || '').trim().replace(/^CAJ\s+/i, '').toLocaleUpperCase('es-CL');
}

function nombreArchivoSeguro(texto) {
  return String(texto || 'Informe_Practica_Profesional')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Informe_Practica_Profesional';
}

function descargarBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function ordenarCronologia(items = []) {
  return items.slice().sort((a, b) => String(a?.fecha || '').localeCompare(String(b?.fecha || '')));
}

export async function generarInformePracticaDocx({
  postulante = '',
  caj = '',
  tutores = [],
  fechaInforme = '',
  causas = []
} = {}) {
  if (!String(postulante).trim()) throw new Error('Falta el nombre del postulante.');
  if (!String(caj).trim()) throw new Error('Falta el CAJ asignado.');
  if (!Array.isArray(tutores) || !tutores.filter(Boolean).length) throw new Error('Falta el abogado/a tutor/a.');
  if (!Array.isArray(causas) || !causas.length) throw new Error('No hay causas registradas para generar el informe.');

  const incompletas = causas.filter(c =>
    !String(c?.rol || '').trim() ||
    !String(c?.tribunal || '').trim() ||
    !String(c?.caratulado || '').trim() ||
    !String(c?.materia || '').trim() ||
    !Array.isArray(c?.cronologia) || c.cronologia.length === 0
  );
  if (incompletas.length) throw new Error(`Hay ${incompletas.length} causa(s) con antecedentes o cronología pendientes.`);

  const response = await fetch('/templates/informe-practica-profesional.docx', { cache: 'no-store' });
  if (!response.ok) throw new Error('No se pudo cargar la plantilla institucional del Informe de Práctica.');
  const buffer = await response.arrayBuffer();
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml')?.asText();
  if (!xml) throw new Error('La plantilla del Informe de Práctica no contiene document.xml.');

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('No se pudo interpretar la plantilla del Informe de Práctica.');
  const body = bodyNode(doc);
  const modelTable = topLevelTables(doc)[0];
  if (!body || !modelTable) throw new Error('No se encontró el bloque institucional de causa en la plantilla.');

  const tutoresLimpios = tutores.map(x => String(x || '').trim()).filter(Boolean);
  const tutorLabel = tutoresLimpios.length > 1 ? 'Abogados/as Tutores/as' : 'Abogado/a Tutor/a';
  replaceParagraphMarker(doc, '{{CAJ}}', normalizarCaj(caj));
  replaceParagraphMarker(doc, '{{POSTULANTE}}', String(postulante).trim().toLocaleUpperCase('es-CL'));
  replaceParagraphMarker(doc, '{{TUTOR_LABEL}}', tutorLabel);
  replaceParagraphMarker(doc, '{{FECHA_INFORME}}', fechaInformeLarga(fechaInforme));

  // Portada: conservar jerarquía del modelo institucional, toda en negrita.
  const coverParagraphs = childrenByLocalName(body, 'p');
  coverParagraphs.forEach(p => {
    const txt = textOf(p).trim();
    if (!txt) return;
    const topTitles = [
      'INFORME DE PRÁCTICA PROFESIONAL',
      'CORPORACIÓN DE ASISTENCIA JUDICIAL METROPOLITANA'
    ];
    if (topTitles.includes(txt) || txt.startsWith('CENTRO DE ATENCIÓN JURÍDICA Y SOCIAL ')) {
      formatParagraph(p, { bold: true, size: '24', font: 'Verdana' });
    } else if (txt === 'Postulante' || txt === String(postulante).trim().toLocaleUpperCase('es-CL') || txt === tutorLabel || txt === fechaInformeLarga(fechaInforme)) {
      formatParagraph(p, { bold: true, size: '20', font: 'Verdana' });
    }
  });

  // Tutores: uno debajo del otro dentro del mismo párrafo, Verdana 10, negrita.
  // Así se conserva exactamente el espaciado vertical de la portada institucional.
  const tutorMarkerParagraph = childrenByLocalName(body, 'p').find(p => textOf(p).includes('{{TUTORES}}'));
  if (tutorMarkerParagraph) {
    setParagraphLines(
      tutorMarkerParagraph,
      tutoresLimpios.map(t => t.toLocaleUpperCase('es-CL')),
      { bold: true, size: '20', font: 'Verdana' }
    );
  }

  const bodyChildren = Array.from(body.childNodes).filter(n => n.nodeType === 1);
  const modelIndex = bodyChildren.indexOf(modelTable);
  const spacerTemplates = [];
  for (const n of bodyChildren.slice(modelIndex + 1, modelIndex + 3)) {
    if (n.localName === 'p' && !textOf(n).trim()) spacerTemplates.push(n.cloneNode(true));
  }

  const narrativeCell = rowCells(tableRows(modelTable)[4] || {})[1];
  const narrativeParagraphs = childrenByLocalName(narrativeCell, 'p');
  const paragraphTemplate = narrativeParagraphs[0]?.cloneNode(true);
  const blankParagraphTemplate = narrativeParagraphs[1]?.cloneNode(true) || doc.createElementNS(W_NS, 'w:p');
  if (!paragraphTemplate) throw new Error('La plantilla no contiene el formato narrativo esperado.');

  // La portada termina con una fecha situada al pie de página. El modelo tenía
  // párrafos vacíos antes de la primera tabla; al poner toda la portada en negrita
  // esos párrafos podían desbordarse a una hoja intermedia. Se eliminan porque la
  // primera tabla ya conserva su pageBreakBefore institucional.
  const beforeModel = Array.from(body.childNodes).filter(n => n.nodeType === 1);
  let cursorBefore = beforeModel.indexOf(modelTable) - 1;
  while (cursorBefore >= 0) {
    const n = beforeModel[cursorBefore];
    if (n.localName !== 'p' || textOf(n).trim()) break;
    n.parentNode.removeChild(n);
    cursorBefore -= 1;
  }

  // Remove the model table and every trailing empty paragraph inherited from the example.
  modelTable.parentNode.removeChild(modelTable);
  let afterModel = Array.from(body.childNodes).filter(n => n.nodeType === 1).slice(modelIndex);
  afterModel.forEach(n => {
    if (n.localName === 'p' && !textOf(n).trim()) n.parentNode.removeChild(n);
  });

  let insertionReference = Array.from(body.childNodes).filter(n => n.nodeType === 1)[modelIndex] || null;
  causas.forEach((causa, index) => {
    const table = modelTable.cloneNode(true);
    if (index > 0) removePageBreakBeforeFromTable(table);
    removeNarrativeMinimumHeight(table);

    setTableCell(table, 0, 1, String(causa.rol || '').trim());
    setTableCell(table, 1, 1, String(causa.tribunal || '').trim().toLocaleUpperCase('es-CL'));
    setTableCell(table, 2, 1, String(causa.caratulado || '').trim().toLocaleUpperCase('es-CL'));
    setTableCell(table, 3, 1, String(causa.materia || '').trim().toLocaleUpperCase('es-CL'));

    // Cuerpo del informe: Verdana 9. Se restaura el margen interno exacto
    // del modelo (154 twips izquierda / 139 derecha) en la columna de contenido.
    tableRows(table).slice(0, 4).forEach((row, rowIndex) => {
      const cells = rowCells(row);
      const labelP = cells[0] ? childrenByLocalName(cells[0], 'p')[0] : null;
      const valueP = cells[1] ? childrenByLocalName(cells[1], 'p')[0] : null;
      formatParagraph(labelP, { bold: true, size: '18', font: 'Verdana' });
      formatParagraph(valueP, { bold: rowIndex === 0, size: '18', font: 'Verdana' });
      setParagraphIndent(valueP, '154', '139');
    });
    const narrativeLabel = rowCells(tableRows(table)[4])[0];
    childrenByLocalName(narrativeLabel, 'p').forEach(p => formatParagraph(p, { bold: true, size: '18', font: 'Verdana' }));

    const cell = rowCells(tableRows(table)[4])[1];
    clearCellKeepProperties(cell);
    const cron = ordenarCronologia(causa.cronologia);
    cron.forEach((g, i) => {
      const fecha = fechaGestion(g?.fecha);
      const desc = String(g?.descripcion || '').trim();
      cell.appendChild(paragraphFromTemplate(paragraphTemplate, { fecha, descripcion: desc }));
      if (i < cron.length - 1) cell.appendChild(blankParagraphTemplate.cloneNode(true));
    });
    cell.appendChild(blankParagraphTemplate.cloneNode(true));
    cell.appendChild(paragraphFromTemplate(paragraphTemplate, { plain: 'Es en cuanto puedo informar sobre esta causa.' }));

    body.insertBefore(table, insertionReference);
    if (index < causas.length - 1) {
      spacerTemplates.forEach(sp => body.insertBefore(sp.cloneNode(true), insertionReference));
    }
  });

  // Limpieza final robusta: algunas versiones de Word/LibreOffice conservan
  // tres párrafos vacíos de la plantilla entre la fecha de portada y la primera
  // tabla. Eso genera una página intermedia completamente en blanco.
  // Eliminamos únicamente los párrafos vacíos inmediatamente anteriores a la
  // primera tabla, sin tocar los espacios internos de la portada.
  const finalChildren = Array.from(body.childNodes).filter(n => n.nodeType === 1);
  const firstGeneratedTable = finalChildren.find(n => n.localName === 'tbl');
  if (firstGeneratedTable) {
    let firstTableIndex = finalChildren.indexOf(firstGeneratedTable);
    while (firstTableIndex > 0) {
      const prev = finalChildren[firstTableIndex - 1];
      if (prev.localName !== 'p' || textOf(prev).trim()) break;
      body.removeChild(prev);
      finalChildren.splice(firstTableIndex - 1, 1);
      firstTableIndex -= 1;
    }
  }

  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  const blob = zip.generate({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
  descargarBlob(blob, `${nombreArchivoSeguro(`Informe_Practica_Profesional_${postulante}`)}.docx`);
}
