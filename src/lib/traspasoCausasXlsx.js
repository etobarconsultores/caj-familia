import PizZip from 'pizzip';

const TEMPLATE_URL = '/templates/traspaso-causas-practicajuris.xlsx';

function fmtFecha(fecha) {
  if (!fecha) return '';
  const m = String(fecha).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(fecha);
}

function buildRows(datos) {
  return {
    causas: (datos.causas || []).map(x => [
      x.numero, fmtFecha(x.fechaIngreso), x.tutor, x.rut, x.patrocinado, x.tipoParte,
      x.procedimiento, x.materia, x.saj, x.caratulado, x.rol, x.tribunal, x.etapa,
      x.queSigue, x.ultimaGestion, fmtFecha(x.fechaUltimaGestion), x.estadoNotificacion,
      x.receptor, x.observaciones
    ]),
    usuarios: (datos.usuarios || []).map(x => [
      x.numero, x.patrocinado, x.rut, x.telefono, x.telefonoAlt, x.correo, x.correoAlt,
      x.clavePjud, x.claveUnica, x.observaciones
    ]),
    audiencias: (datos.audiencias || []).map(x => [
      x.numero, x.rol, x.caratulado, x.tribunal, x.materia, fmtFecha(x.fecha), x.hora,
      x.tipoEvento, x.modalidad, x.link, x.quePreparar, x.observaciones
    ]),
    apelaciones: (datos.apelaciones || []).map(x => [
      x.numero, x.rut, x.patrocinado, x.materia, x.saj, x.caratulado, x.rol, x.tribunal,
      x.recurso, x.rolCorte, x.jurisdiccion, x.parte
    ])
  };
}

function fechaArchivo() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function nombreColumna(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function escaparXml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function capturarPlantillaFila(xml, fila = 4) {
  const reFila = new RegExp(`<row\\b[^>]*\\br="${fila}"[^>]*>[\\s\\S]*?<\\/row>`);
  const matchFila = xml.match(reFila);
  if (!matchFila) throw new Error(`No se encontró la fila de plantilla ${fila}.`);

  const filaXml = matchFila[0];
  const apertura = filaXml.match(/^<row\\b([^>]*)>/)?.[1] || '';
  const attrs = apertura
    .replace(/\s+r="[^"]*"/g, '')
    .replace(/\s+spans="[^"]*"/g, '');

  const estilos = {};
  const reCelda = new RegExp(`<c\\b([^>]*)\\br="([A-Z]+)${fila}"([^>]*)>`, 'g');
  let m;
  while ((m = reCelda.exec(filaXml)) !== null) {
    const attrsCelda = `${m[1]} ${m[3]}`;
    const estilo = attrsCelda.match(/\bs="([^"]+)"/)?.[1] || '';
    estilos[m[2]] = estilo;
  }

  return { attrs, estilos };
}

function crearFilaXml(numeroFila, valores, colCount, plantilla) {
  const celdas = [];
  for (let c = 0; c < colCount; c++) {
    const col = nombreColumna(c);
    const ref = `${col}${numeroFila}`;
    const estilo = plantilla.estilos[col];
    const s = estilo ? ` s="${estilo}"` : '';
    const valor = valores[c] ?? '';

    if (valor === '') {
      celdas.push(`<c r="${ref}"${s}/>`);
      continue;
    }

    celdas.push(
      `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escaparXml(valor)}</t></is></c>`
    );
  }

  return `<row r="${numeroFila}" spans="1:${colCount}"${plantilla.attrs}>${celdas.join('')}</row>`;
}

function reemplazarFilasDatos(xml, filas, { colCount, lastCol }) {
  const plantilla = capturarPlantillaFila(xml, 4);
  const seguras = filas.length ? filas : [Array(colCount).fill('')];

  const sheetDataMatch = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sheetDataMatch) throw new Error('La hoja de la plantilla no contiene sheetData.');

  // Conserva portada y encabezados (filas 1 a 3) y sustituye únicamente
  // las filas de datos. Así permanecen intactos colores, tipografías,
  // bordes, anchos de columnas, filas congeladas, tablas y demás formato.
  const cabecera = sheetDataMatch[1].replace(
    /<row\b[^>]*\br="(?:[4-9]|[1-9]\d+)"[^>]*>[\s\S]*?<\/row>/g,
    ''
  );

  const nuevasFilas = seguras
    .map((fila, i) => crearFilaXml(4 + i, fila, colCount, plantilla))
    .join('');

  xml = xml.replace(
    /<sheetData>[\s\S]*?<\/sheetData>/,
    `<sheetData>${cabecera}${nuevasFilas}</sheetData>`
  );

  const ultimaFila = 3 + seguras.length;
  xml = xml.replace(
    /<dimension ref="[^"]*"\s*\/>/,
    `<dimension ref="A1:${lastCol}${ultimaFila}"/>`
  );

  return { xml, ultimaFila };
}

function actualizarTabla(zip, tablePath, lastCol, ultimaFila) {
  const archivo = zip.file(tablePath);
  if (!archivo) return;

  let xml = archivo.asText();
  const nuevaRef = `A3:${lastCol}${ultimaFila}`;
  xml = xml.replace(/\bref="[^"]+"/, `ref="${nuevaRef}"`);
  zip.file(tablePath, xml);
}

function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escribirHoja(zip, sheetPath, tablePath, filas, config) {
  const archivo = zip.file(sheetPath);
  if (!archivo) throw new Error(`No se encontró ${sheetPath} en la plantilla.`);

  const resultado = reemplazarFilasDatos(archivo.asText(), filas, config);
  zip.file(sheetPath, resultado.xml);
  actualizarTabla(zip, tablePath, config.lastCol, resultado.ultimaFila);
}

export async function generarTraspasoCausasXlsx(datos) {
  const resp = await fetch(TEMPLATE_URL);
  if (!resp.ok) throw new Error('No se pudo cargar la plantilla del Excel de traspaso.');

  const arrayBuffer = await resp.arrayBuffer();
  const zip = new PizZip(arrayBuffer);
  const rows = buildRows(datos);

  escribirHoja(zip, 'xl/worksheets/sheet1.xml', 'xl/tables/table1.xml', rows.causas, {
    colCount: 19, lastCol: 'S'
  });
  escribirHoja(zip, 'xl/worksheets/sheet2.xml', 'xl/tables/table2.xml', rows.usuarios, {
    colCount: 10, lastCol: 'J'
  });
  escribirHoja(zip, 'xl/worksheets/sheet3.xml', 'xl/tables/table3.xml', rows.audiencias, {
    colCount: 12, lastCol: 'L'
  });
  escribirHoja(zip, 'xl/worksheets/sheet4.xml', 'xl/tables/table4.xml', rows.apelaciones, {
    colCount: 12, lastCol: 'L'
  });

  const blob = zip.generate({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE'
  });

  descargarBlob(blob, `Traspaso_causas_vigentes_${fechaArchivo()}.xlsx`);
}
