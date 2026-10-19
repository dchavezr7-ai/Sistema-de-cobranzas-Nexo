import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { soles, fecha, hoyLima } from '../lib/fmt';

const redondear = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// Suma n días exactos a una fecha ISO (YYYY-MM-DD)
function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function calcular(monto, plazo, tasa, fechaIni) {
  const interes = redondear((monto * tasa) / 100);
  const total = redondear(monto + interes);
  const cuota = redondear(total / plazo);
  const cuotas = [];
  for (let i = 1; i <= plazo; i++) {
    cuotas.push({
      numero: i,
      vence: sumarDias(fechaIni, 30 * i),
      monto: i === plazo ? redondear(total - cuota * (plazo - 1)) : cuota,
    });
  }
  return { interes, total, cuotas };
}

export default function PrestamoNuevo() {
  const location = useLocation();
  const clienteInicial = location.state?.clienteId;

  const [config, setConfig] = useState({ tasa: 30, tope: 10000 });
  const [q, setQ] = useState('');
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [cliente, setCliente] = useState(null);
  const [activo, setActivo] = useState(0);

  const [monto, setMonto] = useState('');
  const [plazo, setPlazo] = useState('');
  const [fechaIni, setFechaIni] = useState(hoyLima());

  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [creado, setCreado] = useState(null);

  useEffect(() => {
    supabase.from('configuracion').select('clave, valor').then(({ data }) => {
      if (!data) return;
      const v = Object.fromEntries(data.map((r) => [r.clave, Number(r.valor)]));
      setConfig({ tasa: v.tasa_interes_pct ?? 30, tope: v.tope_capital_cliente ?? 10000 });
    });
  }, []);

  async function elegir(c) {
    setCliente(c);
    setResultados([]);
    setQ('');
    setError('');
    const { data } = await supabase
      .from('prestamos').select('monto_capital')
      .eq('cliente_id', c.id).eq('estado', 'activo');
    setActivo((data || []).reduce((s, p) => s + Number(p.monto_capital), 0));
  }

  useEffect(() => {
    if (!clienteInicial) return;
    supabase.from('clientes').select('id, tipo, dni, ruc, nombre_mostrar')
      .eq('id', clienteInicial).single()
      .then(({ data }) => { if (data) elegir(data); });
  }, [clienteInicial]);

  useEffect(() => {
    const texto = q.replace(/[%*,()]/g, ' ').trim();
    if (texto.length < 2) { setResultados([]); return; }
    let cancelado = false;
    const t = setTimeout(async () => {
      setBuscando(true);
      const { data } = await supabase
        .from('clientes')
        .select('id, tipo, dni, ruc, nombre_mostrar')
        .or(`dni.ilike.*${texto}*,ruc.ilike.*${texto}*,nombre_mostrar.ilike.*${texto}*`)
        .order('nombre_mostrar')
        .limit(8);
      if (!cancelado) { setResultados(data || []); setBuscando(false); }
    }, 300);
    return () => { cancelado = true; clearTimeout(t); };
  }, [q]);

  const disponible = Math.max(config.tope - activo, 0);
  const montoNum = Number(monto);
  const plazoNum = Number(plazo);
  const datosValidos =
    cliente && montoNum > 0 && Number.isInteger(plazoNum) && plazoNum >= 1 && plazoNum <= 60 && fechaIni;
  const excede = cliente && montoNum > disponible;
  const plan = datosValidos ? calcular(montoNum, plazoNum, config.tasa, fechaIni) : null;

  function validar() {
    if (!cliente) return 'Elige un cliente.';
    if (!(montoNum > 0)) return 'El monto debe ser mayor que cero.';
    if (redondear(montoNum) !== montoNum) return 'El monto admite hasta 2 decimales.';
    if (excede) return `El monto supera el cupo disponible (${soles(disponible)}).`;
    if (!Number.isInteger(plazoNum) || plazoNum < 1 || plazoNum > 60)
      return 'El plazo debe ser un número entero de 1 a 60 meses.';
    if (!fechaIni) return 'Indica la fecha de otorgamiento.';
    return '';
  }

  async function guardar(e) {
    e.preventDefault();
    setError('');
    const problema = validar();
    if (problema) return setError(problema);

    setGuardando(true);
    const { data, error: eRpc } = await supabase.rpc('crear_prestamo', {
      p_cliente_id: cliente.id,
      p_monto: redondear(montoNum),
      p_fecha: fechaIni,
      p_plazo: plazoNum,
    });
    setGuardando(false);

    if (eRpc) {
      return setError(
        eRpc.code === '42501' ? 'Tu rol no tiene permiso para registrar préstamos.' : eRpc.message
      );
    }
    const { data: p } = await supabase
      .from('prestamos')
      .select('codigo, monto_capital, monto_interes, total_a_pagar, plazo_meses, fecha_otorgamiento, tasa_interes_pct')
      .eq('id', data).single();
    const { data: primera } = await supabase
      .from('cuotas').select('monto, fecha_vencimiento')
      .eq('prestamo_id', data).order('numero').limit(1).single();
    setCreado({ id: data, ...p, primera, cliente });
  }

  function otro() {
    setCliente(null); setActivo(0); setMonto(''); setPlazo('');
    setFechaIni(hoyLima()); setError(''); setCreado(null);
  }

  if (creado) {
    return (
      <div className="pagina">
        <div className="exito">
          <div className="exito-icono" aria-hidden="true">✓</div>
          <h1>Préstamo registrado</h1>
          <p className="suave">El cronograma de cuotas ya fue generado.</p>

          <div className="exito-codigo">{creado.codigo}</div>
          <div className="exito-cliente">
            <strong>{creado.cliente.nombre_mostrar}</strong>
            <span className="suave chico">
              {creado.cliente.tipo === 'juridica' ? `RUC ${creado.cliente.ruc}` : `DNI ${creado.cliente.dni}`}
            </span>
          </div>

          <dl className="exito-datos">
            <div><dt>Capital</dt><dd>{soles(creado.monto_capital)}</dd></div>
            <div><dt>Interés ({Number(creado.tasa_interes_pct)}%)</dt><dd>{soles(creado.monto_interes)}</dd></div>
            <div className="destacado"><dt>Total a pagar</dt><dd>{soles(creado.total_a_pagar)}</dd></div>
            <div><dt>Plazo</dt><dd>{creado.plazo_meses} {creado.plazo_meses === 1 ? 'mes' : 'meses'}</dd></div>
            <div><dt>Otorgado</dt><dd>{fecha(creado.fecha_otorgamiento)}</dd></div>
            {creado.primera && (
              <div><dt>Primera cuota</dt>
                <dd>{soles(creado.primera.monto)} · {fecha(creado.primera.fecha_vencimiento)}</dd></div>
            )}
          </dl>

          <div className="exito-acciones">
            <button className="btn btn-auto" onClick={otro}>Registrar otro préstamo</button>
            <Link className="btn btn-sec btn-auto" to={`/prestamos/${creado.id}`}>Ver cronograma</Link>
            <Link className="btn btn-sec btn-auto" to="/prestamos">Ir a préstamos</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pagina">
      <div className="cabecera-pagina">
        <div>
          <h1>Registrar préstamo</h1>
          <p className="suave">
            Interés del {config.tasa}% sobre el monto, en cuotas mensuales. Tope de {soles(config.tope)} por cliente.
          </p>
        </div>
      </div>

      <form onSubmit={guardar} noValidate className="tarjeta">
        <section>
          <h2>1. Cliente</h2>
          {!cliente ? (
            <div className="campo">
              <label htmlFor="buscar_cli">Buscar por DNI, RUC o nombre</label>
              <input id="buscar_cli" value={q} autoComplete="off"
                placeholder="Escribe al menos 2 caracteres"
                onChange={(e) => setQ(e.target.value)} />
              {buscando && <p className="ayuda">Buscando…</p>}
              {!buscando && q.trim().length >= 2 && resultados.length === 0 && (
                <p className="ayuda ayuda-aviso">
                  No hay coincidencias. <Link to="/clientes/nuevo">Registrar cliente</Link>
                </p>
              )}
              {resultados.length > 0 && (
                <ul className="lista-resultados">
                  {resultados.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => elegir(c)}>
                        <strong>{c.nombre_mostrar}</strong>
                        <span className="suave chico">
                          {c.tipo === 'juridica' ? `RUC ${c.ruc}` : `DNI ${c.dni}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="cliente-elegido">
              <div>
                <strong>{cliente.nombre_mostrar}</strong>
                <div className="suave chico">
                  {cliente.tipo === 'juridica' ? `RUC ${cliente.ruc}` : `DNI ${cliente.dni}`}
                </div>
              </div>
              <div className="cupo">
                <span className="suave chico">Capital activo {soles(activo)}</span>
                <strong>Cupo disponible {soles(disponible)}</strong>
              </div>
              <button type="button" className="btn btn-sec btn-auto btn-chico"
                onClick={() => { setCliente(null); setActivo(0); }}>Cambiar</button>
            </div>
          )}
        </section>

        <section className="bloque">
          <h2>2. Condiciones</h2>
          <div className="grid-3">
            <div className="campo">
              <label htmlFor="monto">Monto (S/)</label>
              <input id="monto" inputMode="decimal" placeholder="0.00" value={monto}
                onChange={(e) => setMonto(e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))} />
            </div>
            <div className="campo">
              <label htmlFor="plazo">Plazo (meses)</label>
              <input id="plazo" inputMode="numeric" placeholder="1 a 60" value={plazo}
                onChange={(e) => setPlazo(e.target.value.replace(/\D/g, '').slice(0, 2))} />
            </div>
            <div className="campo">
              <label htmlFor="fecha">Fecha de otorgamiento</label>
              <input id="fecha" type="date" value={fechaIni} onChange={(e) => setFechaIni(e.target.value)} />
            </div>
          </div>
          {excede && <p className="ayuda ayuda-error">Supera el cupo disponible de {soles(disponible)}.</p>}
        </section>

        {plan && (
          <section className="bloque">
            <h2>3. Vista previa del cronograma</h2>
            <div className="resumen resumen-3">
              <div className="resumen-item"><span className="suave chico">Capital</span><strong>{soles(montoNum)}</strong></div>
              <div className="resumen-item"><span className="suave chico">Interés ({config.tasa}%)</span><strong>{soles(plan.interes)}</strong></div>
              <div className="resumen-item"><span className="suave chico">Total a pagar</span><strong>{soles(plan.total)}</strong></div>
            </div>
            <div className="tabla-wrap">
              <table className="tabla">
                <thead><tr><th>Cuota</th><th>Vence</th><th>Monto</th></tr></thead>
                <tbody>
                  {plan.cuotas.map((c) => (
                    <tr key={c.numero}><td>{c.numero}</td><td>{fecha(c.vence)}</td><td>{soles(c.monto)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {error && <div className="alerta alerta-error" role="alert">{error}</div>}

        <div className="acciones">
          <button className="btn btn-auto" disabled={guardando || !datosValidos || excede}>
            {guardando ? 'Guardando…' : 'Registrar préstamo'}
          </button>
          <Link className="btn btn-sec btn-auto" to="/prestamos">Cancelar</Link>
        </div>
      </form>
    </div>
  );
}
