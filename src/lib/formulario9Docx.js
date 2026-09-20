import PizZip from 'pizzip';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

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
  const text = String(value ?? '');
  const texts = Array.from(node.getElementsByTagNameNS(W_NS, 't'));
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

function setCell(row, index, value) {
  const cell = rowCells(row)[index];
  setNodeTextPreserve(cell, value);
}

function rolCausa(c) {
  const rit = String(c?.rit || '').trim();
  const rol = String(c?.rol || '').trim();

  // Formato institucional: RIT + ROL separados por guion,
  // igual que el título de la causa (ej.: C-2304-2026).
  if (rit && rol) return `${rit}-${rol}`;

  // Compatibilidad con causas antiguas donde el prefijo venía incluido en rol.
  if (rol && /^[A-Z]-/i.test(rol)) return rol;

  return String(rol || c?.rolIngreso || rit || '').trim();
}

function tribunalCausa(c) {
  // Priorizar siempre los campos normalizados de tribunal.
  // c.tribunal puede contener únicamente el número histórico (ej.: "7"),
  // por lo que no debe ocultar tipo/ciudad cuando estos sí existen.
  const tipo = String(c?.tipoTribunal || '').trim();
  const numero = String(c?.numeroTribunal || '').trim();
  const ciudad = String(c?.ciudadTribunal || '').trim();

  if (tipo) {
    const sinNumero = ['Corte Suprema'].includes(tipo);
    const prefijo = !sinNumero && numero ? `${numero}° ` : '';
    const sufijo = ciudad ? ` de ${ciudad}` : '';
    return `${prefijo}${tipo}${sufijo}`.trim();
  }

  return String(c?.tribunal || '').trim();
}

function estadoCausa(c) {
  return c?.categoria === 'terminada' ? 'Terminada' : 'Vigente';
}

function sugerirPartesNombrePatrocinado(nombreCompleto) {
  const partes = String(nombreCompleto || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!partes.length) return { apellidos: '', nombres: '' };
  if (partes.length === 1) return { apellidos: partes[0], nombres: '' };
  if (partes.length === 2) return { apellidos: partes[1], nombres: partes[0] };
  return {
    apellidos: partes.slice(-2).join(' '),
    nombres: partes.slice(0, -2).join(' ')
  };
}

function partesPatrocinado(c) {
  const apellidos = String(c?.patrocinadoApellidos || '').trim();
  const nombres = String(c?.patrocinadoNombres || '').trim();
  if (apellidos && nombres) return { apellidos, nombres };

  const sugeridos = sugerirPartesNombrePatrocinado(c?.patrocinado || '');
  return {
    apellidos: apellidos || sugeridos.apellidos || '',
    nombres: nombres || sugeridos.nombres || ''
  };
}

function nombreArchivoSeguro(texto) {
  return String(texto || 'Formulario_N9_Listado_Causas')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Formulario_N9_Listado_Causas';
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

export async function generarFormulario9Docx({ causas = [] } = {}) {
  if (!Array.isArray(causas) || !causas.length) {
    throw new Error('No hay causas registradas para generar el Formulario N°9.');
  }

  const incompletas = causas.filter(c => {
    const p = partesPatrocinado(c);
    return (
      !p.apellidos ||
      !p.nombres ||
      !String(c?.folio || '').trim() ||
      !rolCausa(c) ||
      !tribunalCausa(c) ||
      !String(c?.materia || c?.subcategoria || '').trim() ||
      !['Nueva', 'Traspasada'].includes(c?.origenCarpeta)
    );
  });
  if (incompletas.length) {
    throw new Error(`Hay ${incompletas.length} causa(s) con datos pendientes para el Formulario N°9.`);
  }

  const response = await fetch('/templates/formulario-9-listado-causas.docx', { cache: 'no-store' });
  if (!response.ok) throw new Error('No se pudo cargar la plantilla institucional del Formulario N°9.');
  const buffer = await response.arrayBuffer();
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml')?.asText();
  if (!xml) throw new Error('La plantilla del Formulario N°9 no contiene document.xml.');

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const tables = getTopLevelTables(doc);
  const table = tables[1];
  if (!table) throw new Error('No se encontró la tabla institucional del Formulario N°9.');

  const rows = tableRows(table);
  if (rows.length < 3) throw new Error('La tabla institucional del Formulario N°9 no contiene una fila modelo.');
  const templateRow = rows[2].cloneNode(true);
  rows.slice(2).forEach(r => r.parentNode.removeChild(r));

  causas.forEach((c, i) => {
    const row = templateRow.cloneNode(true);
    const p = partesPatrocinado(c);
    setCell(row, 0, i + 1);
    setCell(row, 1, p.apellidos);
    setCell(row, 2, p.nombres);
    setCell(row, 3, String(c.materia || c.subcategoria || '').trim());
    setCell(row, 4, String(c.folio || '').trim());
    setCell(row, 5, rolCausa(c));
    setCell(row, 6, tribunalCausa(c));
    setCell(row, 7, c.origenCarpeta);
    setCell(row, 8, estadoCausa(c));
    table.appendChild(row);
  });

  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  const blob = zip.generate({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
  const filename = `${nombreArchivoSeguro('Formulario_N9_Listado_Causas')}.docx`;
  descargarBlob(blob, filename);
}
