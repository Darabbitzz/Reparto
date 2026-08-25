'use strict';
// ============================================================
// generar-precios.js — el artefacto de GitHub Actions.
// NO es un módulo de la app: no se carga en index.html y no toca el estado.
// Lee tickers.json, pide cierres a Yahoo y a CoinGecko, y escribe precios.json con los
// bloques `precios` (vivo, por ISIN) e `historico` (por activoId). ARQUITECTURA (b) y (d).
//
//   node generar-precios.js                              # el mes recién cerrado
//   node generar-precios.js --desde 2024-04 --hasta 2026-06   # backfill
//   node generar-precios.js --dry-run                    # no escribe nada
//
// Partido en dos por la rev. 6.6: `construir` es puro y verificable con respuestas de mentira,
// y `ejecutar` es la única parte que habla con la red.
// ============================================================

// ---------------- utilidades sin dominio ----------------
function esObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function precioValido(v) { return typeof v === 'number' && isFinite(v) && v > 0; }
function esFecha(t) { return typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t); }
function esMes(t) { return typeof t === 'string' && /^\d{4}-\d{2}$/.test(t); }
function copia(x) { try { return JSON.parse(JSON.stringify(x)); } catch (_) { return null; } }

function mesDe(fecha) { return String(fecha).slice(0, 7); }

function sumarMeses(ym, n) {
  var a = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10) - 1 + n;
  a += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return String(a) + '-' + String(m + 1).padStart(2, '0');
}

// Los precios se publican con dos decimales, que es la unidad en la que cotiza todo lo que hay
// en tickers.json. Por debajo de 1 € se guardan ocho: un token barato redondeado a dos céntimos
// pierde el precio entero.
function redondearPrecio(v) {
  if (!isFinite(v)) return null;
  var d = Math.abs(v) >= 1 ? 100 : 1e8;
  return Math.round(v * d) / d;
}
function redondear2(v) { return isFinite(v) ? Math.round(v * 100) / 100 : null; }

// ---------------- entrada ----------------
// Acepta el formato de la rev. 6.6 ({ tickers, cripto }) y el mapa plano de la 6.2, porque es un
// archivo que el usuario edita a mano desde el móvil.
function normalizarTickers(bruto) {
  var salida = { porIsin: {}, cripto: {} };
  if (!esObjeto(bruto)) return salida;

  var fuente = esObjeto(bruto.tickers) ? bruto.tickers : bruto;
  Object.keys(fuente).forEach(function (clave) {
    if (clave === 'schema' || clave === 'tickers' || clave === 'cripto') return;
    var e = fuente[clave];
    if (!esObjeto(e) || typeof e.activoId !== 'string') return;
    salida.porIsin[clave] = {
      activoId: e.activoId,
      simbolo: typeof e.simbolo === 'string' ? e.simbolo : null,
      fuente: typeof e.fuente === 'string' ? e.fuente : 'yahoo',
      nombre: typeof e.nombre === 'string' ? e.nombre : null
    };
  });

  if (esObjeto(bruto.cripto)) {
    Object.keys(bruto.cripto).forEach(function (activoId) {
      var e = bruto.cripto[activoId];
      if (!esObjeto(e) || typeof e.coingeckoId !== 'string') return;
      salida.cripto[activoId] = {
        coingeckoId: e.coingeckoId,
        nombre: typeof e.nombre === 'string' ? e.nombre : null
      };
    });
  }
  return salida;
}

function cierresValidos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter(function (c) { return esObjeto(c) && esFecha(c.fecha) && precioValido(c.cierre); })
    .sort(function (a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });
}

function leerFx(descarga, previo) {
  if (esObjeto(descarga) && descarga.ok === true && esObjeto(descarga.valores)) {
    var fx = {};
    Object.keys(descarga.valores).forEach(function (m) {
      // Yahoo devuelve el cambio con toda la basura del float (0.8787000179290771). Seis cifras
      // significativas y no cuatro decimales: un yen a cuatro decimales pierde medio por ciento.
      if (precioValido(descarga.valores[m])) fx[m] = Number(descarga.valores[m].toPrecision(6));
    });
    fx.fecha = esFecha(descarga.fecha) ? descarga.fecha : null;
    return fx;
  }
  return (previo && esObjeto(previo.fx)) ? copia(previo.fx) : null;
}

// Londres cotiza en GBp —peniques—, no en GBP. Sin el /100 el oro sale multiplicado por cien.
function factorDe(moneda, fx) {
  if (moneda == null || moneda === 'EUR') return 1;
  if (moneda === 'GBp' || moneda === 'GBX') {
    return (fx && precioValido(fx.GBP)) ? fx.GBP / 100 : null;
  }
  return (fx && precioValido(fx[moneda])) ? fx[moneda] : null;
}

// ---------------- núcleo puro ----------------
function construir(opciones) {
  var op = esObjeto(opciones) ? opciones : {};
  var ahora = typeof op.ahora === 'string' ? op.ahora : null;
  var t = normalizarTickers(op.tickers);
  var descargas = esObjeto(op.descargas) ? op.descargas : {};
  var previo = esObjeto(op.previo) ? op.previo : null;
  var avisos = [];

  var fx = leerFx(descargas.fx, previo);
  if (fx == null) avisos.push({ codigo: 'fx_ausente', mensaje: 'sin tabla de cambio; solo se publican los símbolos en euros' });

  var deYahoo = esObjeto(descargas.yahoo) ? descargas.yahoo : {};
  var deCoingecko = esObjeto(descargas.coingecko) ? descargas.coingecko : {};

  // --- bloque `precios`: vivo, por ISIN. La cripto no entra: la app la pide ella misma. ---
  var precios = {};
  var cierreDe = null;

  Object.keys(t.porIsin).forEach(function (isin) {
    var conf = t.porIsin[isin];
    var d = conf.simbolo != null ? deYahoo[conf.simbolo] : null;
    var cierres = (esObjeto(d) && d.ok === true) ? cierresValidos(d.cierres) : [];
    var factor = (esObjeto(d) && d.ok === true) ? factorDe(d.moneda, fx) : null;

    if (cierres.length > 0 && factor != null) {
      var ult = cierres[cierres.length - 1];
      var entrada = {
        simbolo: conf.simbolo,
        nombre: conf.nombre,
        precio: redondearPrecio(ult.cierre * factor),
        moneda: 'EUR',
        fecha: ult.fecha,
        estado: 'ok',
        fuente: conf.fuente
      };
      if (cierres.length > 1) {
        entrada.cierreAnterior = redondearPrecio(cierres[cierres.length - 2].cierre * factor);
        if (precioValido(entrada.cierreAnterior)) {
          entrada.variacionPct = redondear2((entrada.precio / entrada.cierreAnterior - 1) * 100);
        }
      }
      precios[isin] = entrada;
      if (cierreDe == null || ult.fecha > cierreDe) cierreDe = ult.fecha;
      return;
    }

    // Falló. Regla 2 de (b): nunca se publica un archivo peor que el anterior.
    var motivo = (esObjeto(d) && d.ok === true && factor == null) ? 'fx_ausente'
      : (esObjeto(d) && typeof d.motivo === 'string') ? d.motivo
        : 'sin_datos';
    var anterior = (previo && esObjeto(previo.precios)) ? previo.precios[isin] : null;

    if (esObjeto(anterior) && precioValido(anterior.precio)) {
      var conservada = copia(anterior);
      conservada.estado = 'stale';
      conservada.motivo = motivo === 'fx_ausente'
        ? 'fx_ausente; se conserva último cierre bueno'
        : 'fuente no respondió; se conserva último cierre bueno';
      precios[isin] = conservada;
      avisos.push({ codigo: 'fuente_caida', activoId: conf.activoId, mensaje: isin + ': ' + motivo });
    } else {
      precios[isin] = {
        simbolo: null, nombre: conf.nombre, precio: null, moneda: 'EUR', fecha: null,
        estado: 'error', motivo: motivo, fuente: null
      };
      avisos.push({ codigo: 'sin_cobertura', activoId: conf.activoId, mensaje: isin + ': ' + motivo });
    }
  });

  if (cierreDe == null && previo && esFecha(previo.cierreDe)) cierreDe = previo.cierreDe;

  // --- bloque `historico`: por activoId, mes cerrado, nunca se reescribe ---
  var historico = esObjeto(previo && previo.historico) ? copia(previo.historico) : {};
  if (!esObjeto(historico)) historico = {};

  var fuentes = {};
  Object.keys(t.porIsin).forEach(function (isin) {
    var conf = t.porIsin[isin];
    var d = conf.simbolo != null ? deYahoo[conf.simbolo] : null;
    if (!esObjeto(d) || d.ok !== true) { fuentes[conf.activoId] = null; return; }
    var factor = factorDe(d.moneda, fx);
    fuentes[conf.activoId] = factor == null ? null : { cierres: cierresValidos(d.cierres), factor: factor };
  });
  Object.keys(t.cripto).forEach(function (activoId) {
    var d = deCoingecko[t.cripto[activoId].coingeckoId];
    fuentes[activoId] = (esObjeto(d) && d.ok === true) ? { cierres: cierresValidos(d.cierres), factor: 1 } : null;
  });

  var objetivo = mesesObjetivo(op.meses, ahora);
  Object.keys(fuentes).forEach(function (activoId) {
    var faltan = [];
    objetivo.forEach(function (ym) {
      // Regla 1 de (b): se añade, nunca se reescribe un mes ya escrito.
      if (esObjeto(historico[activoId]) && historico[activoId][ym] != null) return;
      var precio = cierreDelMes(fuentes[activoId], ym);
      if (precio == null) { faltan.push(ym); return; }
      if (!esObjeto(historico[activoId])) historico[activoId] = {};
      historico[activoId][ym] = precio;
    });
    if (faltan.length > 0) {
      avisos.push({
        codigo: 'historico_incompleto', activoId: activoId, meses: faltan,
        mensaje: activoId + ': sin cierre para ' + faltan.join(', ') + '; se deja el hueco'
      });
    }
  });

  var json = {
    schema: 1,
    generado: ahora,
    cierreDe: cierreDe,
    monedaBase: 'EUR',
    fx: fx,
    precios: precios,
    historico: historico
  };

  return { json: json, avisos: avisos, cambia: hayCambio(json, previo) };
}

// Regla 3 de (b): un mes sin dato se omite. Ni se interpola ni se arrastra el anterior.
function cierreDelMes(fuente, ym) {
  if (!esObjeto(fuente)) return null;
  var delMes = fuente.cierres.filter(function (c) { return mesDe(c.fecha) === ym; });
  if (delMes.length === 0) return null;
  var precio = redondearPrecio(delMes[delMes.length - 1].cierre * fuente.factor);
  return precioValido(precio) ? precio : null;
}

// El mes en curso NO se escribe nunca, ni pidiéndolo por rango. Yahoo sirve una barra diaria
// provisional del día en marcha, y como un mes escrito no se reescribe jamás, un backfill
// lanzado a media sesión congelaría ese precio a medio hacer como cierre del mes. Sin un `ahora`
// válido no hay forma de saber cuál es el mes en curso, así que no se escribe nada.
function mesesObjetivo(meses, ahora) {
  var enCurso = (typeof ahora === 'string' && esMes(mesDe(ahora))) ? mesDe(ahora) : null;
  if (enCurso == null) return [];
  if (esObjeto(meses) && esMes(meses.desde) && esMes(meses.hasta)) {
    var salida = [], ym = meses.desde, tope = 0;
    while (ym <= meses.hasta && tope++ < 600) {
      if (ym < enCurso) salida.push(ym);
      ym = sumarMeses(ym, 1);
    }
    return salida;
  }
  return [sumarMeses(enCurso, -1)];
}

// Regla 4 de (d): commit solo si algo cambió. `generado` cambia siempre, así que no cuenta.
function hayCambio(json, previo) {
  if (!esObjeto(previo)) return true;
  var a = copia(json) || {}, b = copia(previo) || {};
  delete a.generado; delete b.generado;
  return JSON.stringify(a) !== JSON.stringify(b);
}

// ---------------- cáscara: lo único que habla con la red ----------------
var URL_YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
var URL_COINGECKO = 'https://api.coingecko.com/api/v3/coins/';

function diaDe(epochSegundos) {
  return new Date(epochSegundos * 1000).toISOString().slice(0, 10);
}

async function pedirJson(buscar, url) {
  var r = await buscar(url, { headers: { 'User-Agent': 'reparto-app/1.0' } });
  if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
  return await r.json();
}

async function bajarYahoo(buscar, simbolo, desdeEpoch) {
  var rango = desdeEpoch != null
    ? '?interval=1d&period1=' + desdeEpoch + '&period2=' + Math.floor(Date.now() / 1000)
    : '?interval=1d&range=1mo';
  var cuerpo = await pedirJson(buscar, URL_YAHOO + encodeURIComponent(simbolo) + rango);
  var r = cuerpo && cuerpo.chart && cuerpo.chart.result && cuerpo.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) throw new Error('respuesta sin cotizaciones');
  var cierre = r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
  if (!Array.isArray(cierre)) throw new Error('respuesta sin cierres');
  var cierres = [];
  for (var i = 0; i < r.timestamp.length; i++) {
    if (precioValido(cierre[i])) cierres.push({ fecha: diaDe(r.timestamp[i]), cierre: cierre[i] });
  }
  return { ok: true, simbolo: simbolo, moneda: (r.meta && r.meta.currency) || null, cierres: cierres };
}

async function bajarCoingecko(buscar, id, dias) {
  var cuerpo = await pedirJson(buscar, URL_COINGECKO + encodeURIComponent(id) +
    '/market_chart?vs_currency=eur&days=' + dias + '&interval=daily');
  if (!cuerpo || !Array.isArray(cuerpo.prices)) throw new Error('respuesta sin precios');
  return {
    ok: true,
    cierres: cuerpo.prices
      .filter(function (p) { return Array.isArray(p) && precioValido(p[1]); })
      .map(function (p) { return { fecha: new Date(p[0]).toISOString().slice(0, 10), cierre: p[1] }; })
  };
}

// Un intento y un reintento, igual que el módulo `precios`. Un símbolo que falla no tumba el
// fichero: se anota y el resto sigue (regla 5 de (d)).
async function conReintento(esperar, fn) {
  try { return await fn(); }
  catch (_) {
    try { if (esperar) await esperar(2000); return await fn(); }
    catch (x) { return { ok: false, motivo: String((x && x.message) || x).slice(0, 120) }; }
  }
}

async function ejecutar(opciones) {
  var op = esObjeto(opciones) ? opciones : {};
  var buscar = op.buscar;
  var esperar = op.esperar;
  var t = normalizarTickers(op.tickers);
  var descargas = { yahoo: {}, coingecko: {}, fx: null };

  var desdeEpoch = null, diasCripto = 365;
  if (esObjeto(op.meses) && esMes(op.meses.desde)) {
    desdeEpoch = Math.floor(Date.parse(op.meses.desde + '-01T00:00:00Z') / 1000);
  }

  var monedas = ['USD', 'GBP'];
  descargas.fx = await conReintento(esperar, async function () {
    var valores = {}, fecha = null;
    for (var i = 0; i < monedas.length; i++) {
      var d = await bajarYahoo(buscar, monedas[i] + 'EUR=X', null);
      var ult = cierresValidos(d.cierres).pop();
      if (ult) { valores[monedas[i]] = ult.cierre; fecha = ult.fecha; }
    }
    return { ok: true, fecha: fecha, valores: valores };
  });

  var isines = Object.keys(t.porIsin);
  for (var i = 0; i < isines.length; i++) {
    var conf = t.porIsin[isines[i]];
    if (conf.simbolo == null) continue;
    descargas.yahoo[conf.simbolo] = await conReintento(esperar,
      bajarYahoo.bind(null, buscar, conf.simbolo, desdeEpoch));
  }

  var ids = Object.keys(t.cripto);
  for (var j = 0; j < ids.length; j++) {
    var cg = t.cripto[ids[j]].coingeckoId;
    descargas.coingecko[cg] = await conReintento(esperar,
      bajarCoingecko.bind(null, buscar, cg, diasCripto));
  }

  return construir({
    tickers: op.tickers, previo: op.previo, descargas: descargas,
    ahora: op.ahora, meses: op.meses
  });
}

module.exports = { construir: construir, ejecutar: ejecutar, normalizarTickers: normalizarTickers };

// ---------------- CLI ----------------
if (require.main === module) {
  (async function () {
    var fs = require('fs');
    var args = process.argv.slice(2);
    var valor = function (n) { var i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
    var rutaTickers = valor('--tickers') || 'tickers.json';
    var rutaSalida = valor('--salida') || 'precios.json';
    var desde = valor('--desde'), hasta = valor('--hasta');
    var seco = args.indexOf('--dry-run') >= 0;

    var leer = function (ruta) {
      try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (_) { return null; }
    };
    var tickers = leer(rutaTickers);
    if (tickers == null) { console.error('no se pudo leer ' + rutaTickers); process.exit(1); }

    var r = await ejecutar({
      tickers: tickers,
      previo: leer(rutaSalida),
      buscar: globalThis.fetch,
      esperar: function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); },
      ahora: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      meses: (desde && hasta) ? { desde: desde, hasta: hasta } : null
    });

    r.avisos.forEach(function (a) { console.log('  aviso  ' + a.codigo + ': ' + a.mensaje); });
    var vivos = Object.keys(r.json.precios).filter(function (k) { return r.json.precios[k].estado === 'ok'; });
    console.log('  ' + vivos.length + '/' + Object.keys(r.json.precios).length +
      ' símbolos ok, cierre de ' + r.json.cierreDe);

    // Regla 2 de (b): si el archivo entero fallara, no se commitea.
    if (vivos.length === 0 && Object.keys(r.json.precios).length > 0) {
      console.error('  ningún símbolo respondió: no se escribe nada');
      process.exit(1);
    }
    if (!r.cambia) { console.log('  sin cambios: no se escribe'); process.exit(0); }
    if (seco) { console.log('  --dry-run: no se escribe'); process.exit(0); }

    fs.writeFileSync(rutaSalida, JSON.stringify(r.json, null, 2) + '\n');
    console.log('  escrito ' + rutaSalida);
  })().catch(function (x) { console.error(x); process.exit(1); });
}
