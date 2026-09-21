import useMain from '../composables/useMain.js'
import processDivergence from '../composables/processDivergence.js'
const instanceUseMain = new useMain()

const divergencias = {
  bajista: [],
  alcista: []
}

// el render de divergencias pertenece al main thread;
// aqui solo se sincronizan los datos y se calculan indicadores
const leneasRenderDivergences = {
  alcistas: [],
  bajistas: []
}

const resetDivergences = (divergenciasRef) => {
  if (divergenciasRef.alcista) {
    leneasRenderDivergences.alcistas.forEach(resetLines)
  }

  if (divergenciasRef.bajista) {
    leneasRenderDivergences.bajistas.forEach(resetLines)
  }

  divergenciasRef.alcista = []
  divergenciasRef.bajista = []
}

const resetLines = (divergenceL) => {
  divergenceL.setData([])
}

/**
 * Comandos del worker.
 *
 * Protocolo de entrada: `{ command, ...payload, reqId? }`.
 * Protocolo de salida: `{ response, data?, ..., reqId? }`.
 *
 * `reqId` se ecoa tal cual para que el cliente (useChartWorker.js) pueda
 * descartar respuestas obsoletas. Chart.vue no lo envia y sigue funcionando
 * igual: todos los comandos previos conservan su forma de respuesta.
 */
const handlers = {
  async calculateCCI({ data, period = 89, reqId }, post) {
    const cci = await instanceUseMain.calcularCCI(data, period)
    post({ response: 'cci', data: cci }, reqId)
  },

  async searchData({ data, reqId }, post) {
    const { exchange, interval, symbolsPairs, cci = false, type } = data
    const d = await instanceUseMain.searchData({
      exchange,
      interval,
      symbolsPairs,
      limit: 500,
      cci,
      type
    })
    post({ response: 'searchData', data: d }, reqId)
  },

  async searchDataPrevius({ data, reqId }, post) {
    const { exchange, interval, symbolsPairs, cci = false, endTime, type } = data
    const d = await instanceUseMain.searchData({
      exchange,
      interval,
      symbolsPairs,
      limit: 500,
      cci,
      endTime,
      type
    })
    post({ response: 'searchDataPrevius', data: d }, reqId)
  },

  calculateEma({ data, ema = 10, color = '#fff', reqId }, post) {
    const r = instanceUseMain.calculateEMA(data, ema, color)
    post({ response: 'ema', ema, data: r }, reqId)
  },

  async rsi({ data, reqId }, post) {
    const r = await instanceUseMain.calculoRSI(data)
    post({ response: 'rsi', data: r }, reqId)
  },

  /**
   * Cierre de vela: recalcula los indicadores de la ultima vela sobre la serie
   * completa. Devuelve solo la vela enriquecida; el armado de la vela siguiente
   * (que depende del delta de tiempo del store) se queda en el componente.
   *
   * `count` > 1 pide ademas el tail enriquecido (resync tras reconexion del
   * socket). El camino de cierre de vela no lo envia: payload identico al de
   * siempre.
   */
  async recalculeIndicators({ data, count, reqId }, post) {
    const dataUpdate = await instanceUseMain.recalculeIndicators(data)
    const tail =
      count > 1 && Array.isArray(dataUpdate.dt_order)
        ? dataUpdate.dt_order.slice(-count)
        : undefined
    post({ response: 'recalculeIndicators', data: { last: dataUpdate.last, tail } }, reqId)
  },

  /**
   * Resync tras reconexion del socket: klines crudos de las ultimas velas, sin
   * indicadores. El componente los mezcla por `time` y re-enriquece el tail
   * con `recalculeIndicators`.
   */
  async searchKlinesRecent({ data, reqId }, post) {
    const { exchange, interval, symbolsPairs, type, limit = 5 } = data
    const d = await instanceUseMain.searchKlinesRaw({
      exchange,
      interval,
      symbolsPairs,
      limit,
      type
    })
    post({ response: 'searchKlinesRecent', data: d }, reqId)
  },

  async heikinAshi({ data, reqId }, post) {
    const dtHeikin = await instanceUseMain.calculoVelasHeikinAshi(data)
    post({ response: 'heikinAshi', data: dtHeikin }, reqId)
  },

  async lastRsi({ data, reqId }, post) {
    const rsiData = await instanceUseMain.calculoRSI(data)
    post({ response: 'lastRsi', data: rsiData.at(-1) ?? null }, reqId)
  },

  /**
   * Enriquecido del camino del store (`/alpha/spot`, paneles de `Ind.vue`):
   * CCI + RSI sobre las velas y devuelve solo el tramo que tiene ambos
   * indicadores calculados, en orden ascendente de tiempo.
   *
   * Replica `enrichWithCciAndRsi` de `stores/chart.js`, que se conserva como
   * respaldo en el hilo principal si el worker no esta disponible.
   */
  async enrichCciRsi({ data, cciPeriod = 20, reqId }, post) {
    const candles = data && data.candles
    if (!Array.isArray(candles) || candles.length < cciPeriod) {
      post({ response: 'enrichCciRsi', data: candles || [] }, reqId)
      return
    }

    const closedValues = candles.map((d) => d.close)
    const cciValues = instanceUseMain.calcularCCI(candles, cciPeriod)
    const rsiValues = await instanceUseMain.calculoRSI(closedValues)

    const enriched = []
    let limit = cciValues.length - 1

    for (let i = candles.length - 1; i >= 0; i--) {
      if (!cciValues[limit] || !rsiValues[limit] || !candles[i]?.time) {
        break
      }

      candles[i].cci = cciValues[limit]
      applyCciColor(candles[i])
      candles[i].rsi = rsiValues[limit]
      enriched.push(candles[i])

      limit--
    }

    enriched.sort((a, b) => a.time - b.time)

    post({ response: 'enrichCciRsi', data: enriched }, reqId)
  },

  syncLinesDivergence({ data }) {
    if (!data) {
      return
    }
    leneasRenderDivergences.alcistas = data.alcistas
    leneasRenderDivergences.bajistas = data.bajistas
  },

  resetCustomIndicator({ data, reqId }, post) {
    if (!data) {
      return
    }
    divergencias.alcista = data.alcista
    divergencias.bajista = data.bajista
    resetDivergences(divergencias)

    post(
      {
        response: 'responseResetDivergences',
        data: {
          alcista: [],
          bajista: []
        }
      },
      reqId
    )
  },

  processDivergence({ data, reqId }, post) {
    if (!data) {
      return
    }
    const instanceDivergencesProcess = new processDivergence(data)
    return new Promise((resolve) => {
      instanceDivergencesProcess.agregarCallback((dt) => {
        divergencias.alcista = dt.alcista
        divergencias.bajista = dt.bajista
      })
      resolve(instanceDivergencesProcess.iniciarProceso())
    }).then(() => {
      post(
        {
          response: 'responseProcessDivergence',
          data: instanceDivergencesProcess.divergencias
        },
        reqId
      )
    })
  },

  /**
   * Calcula de una pasada todas las series que el chart va a pintar. El
   * componente solo aplica `setData` con el resultado.
   *
   * Entrada: `{ data: velas, series: { ema:[{period,color}], sma:[...],
   * hma:[...], bb, psar, kernelChannel, volume } }`.
   * Salida: `{ bb, ema:{[period]:[]}, sma:{...}, hma:{...}, psar, kernel, volume }`.
   *
   * La aritmetica replica exactamente la que hacia el componente en el hilo
   * principal (colores y orden incluidos), solo que fuera del hilo de UI.
   */
  series({ data, series = {}, reqId }, post) {
    if (!data || !data.length) {
      post({ response: 'series', data: {} }, reqId)
      return
    }

    const out = {}

    if (series.bb) {
      out.bb = {
        upper: data
          .map((d) =>
            d.high > d.bb.upper
              ? { value: d.bb.upper, time: d.time, color: '#f443369e' }
              : { value: d.bb.upper, time: d.time }
          )
          .sort((a, b) => a.time - b.time),
        lower: data
          .map((d) =>
            d.low < d.bb.lower
              ? { value: d.bb.lower, time: d.time, color: '#00ffa58a' }
              : { value: d.bb.lower, time: d.time }
          )
          .sort((a, b) => a.time - b.time),
        middle: data
          .map((d) => ({ value: d.bb.middle, time: d.time }))
          .sort((a, b) => a.time - b.time)
      }
    }

    // hma10/hma20 ya vienen enriquecidos en la vela; periodos mayores se calculan
    if (series.hma) {
      out.hma = {}
      series.hma.forEach(({ period, color }) => {
        if (period === 10) {
          out.hma[10] = data.map((d) => ({ value: d.hma10, time: d.time }))
        } else if (period === 20) {
          out.hma[20] = data.map((d) => ({ value: d.hma20, time: d.time }))
        } else {
          out.hma[period] = instanceUseMain.calculateHMA(data, period, color)
        }
      })
    }

    if (series.ema) {
      out.ema = {}
      series.ema.forEach(({ period, color }) => {
        out.ema[period] = instanceUseMain.calculateEMA(data, period, color)
      })
    }

    // `kind` conserva la diferencia que ya existia en el componente: el render
    // completo (renderSmas) usaba calculateEMA y el toggle del menu usaba
    // calcularSMA. Se mantiene tal cual para no cambiar lo que se ve.
    if (series.sma) {
      out.sma = {}
      series.sma.forEach(({ period, color, kind = 'ema' }) => {
        out.sma[period] =
          kind === 'sma'
            ? instanceUseMain.calcularSMA(data, period, color)
            : instanceUseMain.calculateEMA(data, period, color)
      })
    }

    if (series.psar) {
      const highValues = data.map((d) => d.high)
      const lowValues = data.map((d) => d.low)
      const psar = instanceUseMain.calculoPSAR(lowValues, highValues)
      out.psar = psar.map((v, i) => ({
        value: v,
        time: data[i].time,
        color: data[i].close > v ? 'aqua' : 'red'
      }))
    }

    if (series.kernelChannel) {
      const channelData = instanceUseMain.kernelChannel(data, 89, 3.5)
      out.kernel = {
        upper: channelData.map((d) => ({
          time: d.time,
          value: parseFloat(parseFloat(d.upperChannel).toFixed(4))
        })),
        lower: channelData.map((d) => ({
          time: d.time,
          value: parseFloat(parseFloat(d.lowerChannel).toFixed(4))
        })),
        center: channelData.map((d, i) => ({
          time: d.time,
          value: parseFloat(parseFloat(d.smoothedData).toFixed(4)),
          color: parseFloat(d.smoothedData) < data[i].close ? '#A6FF96' : '#DA0C81'
        }))
      }
    }

    if (series.volume) {
      out.volume = calcularVolumen(data)
    }

    post({ response: 'series', data: out }, reqId)
  }
}

// Umbrales y colores del CCI, identicos a los de stores/chart.js
const CCI_OVERBOUGHT = 100
const CCI_OVERSOLD = -100
const CCI_BULLISH_COLOR = '#00f5d4'
const CCI_BEARISH_COLOR = '#ff006e'

/**
 * Pinta la vela segun su CCI (sobrecompra/sobreventa). Muta la vela: el
 * objeto viaja al main thread por structured clone, asi que mutarlo aqui
 * es seguro y evita un segundo recorrido alli.
 */
function applyCciColor(candle) {
  let color = null

  if (candle.cci > CCI_OVERBOUGHT) {
    color = CCI_BULLISH_COLOR
  }

  if (candle.cci < CCI_OVERSOLD) {
    color = CCI_BEARISH_COLOR
  }

  if (color) {
    candle.color = color
    candle.borderColor = color
    candle.wickColor = color
  }
}

/**
 * Volumen + resaltado estadistico (media/moda/mediana, umbral media*2.5).
 * Extraido del componente para poder correr fuera del hilo de UI.
 */
function calcularVolumen(data) {
  const formato = data.map((d) => ({
    time: d.time,
    value: d.volume,
    color: '#d1e1e159'
  }))

  const valores = formato.map((item) => item.value)
  const media = valores.reduce((acc, val) => acc + val, 0) / (valores.length || 1)

  const umbral = parseInt(media * 2.5)

  return formato.map((dt) => {
    if (dt.value >= umbral) {
      return { ...dt, color: '#96EFFF' }
    }
    return dt
  })
}

self.onmessage = async (e) => {
  const { command, reqId } = e.data || {}
  // `command` viaja de vuelta para que el cliente agrupe por canal: el nombre de
  // la respuesta no siempre coincide con el del comando (calculateCCI -> cci)
  const post = (payload, id) => {
    self.postMessage({
      ...payload,
      command,
      ...(id == null ? {} : { reqId: id })
    })
  }

  const handler = handlers[command]

  if (!handler) {
    post({ response: 'error', data: { command, message: `comando desconocido: ${command}` } }, reqId)
    return
  }

  try {
    await handler(e.data, post)
  } catch (error) {
    // reporta el fallo al main thread para que pueda liberar flags de carga
    post({ response: 'error', data: { command, message: String(error) } }, reqId)
  }
}
