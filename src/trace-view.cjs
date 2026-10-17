const { createElement: el, useState, useEffect } = require('react')

function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60000)} m ${Math.round(ms % 60000 / 1000)} s`
}

function numeric(value) { return Number.isFinite(value) ? Math.round(value).toLocaleString() : '—' }
const liveStates = new Set(['preparing', 'waiting', 'ready'])
const appliedStates = new Set(['applied', 'superseded'])
function problem(record) { return record.status === 'failed' || record.status === 'discarded' || record.warmup?.status === 'failed'
  || ['failed', 'missing-checkpoint', 'no-output'].includes(record.response?.status) }
function time(value) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—' }

function Status({ record, t }) {
  return el('span', { className: 'fc-status', 'data-status': record.status },
    el('span', { className: 'fc-dot', 'aria-hidden': true }), t(`trace.status.${record.status}`))
}

function Metric({ label, value, note }) {
  return el('div', { className: 'fc-metric' }, el('span', null, label), el('strong', null, value), note && el('small', null, note))
}

function Lifecycle({ record, t }) {
  const background = record.mode === 'background'
  const phases = background ? [
    ['prepare', record.generationMs, record.readyAt], ['wait', record.waitMs, record.waitStartedAt],
    ['commit', record.commitMs, record.appliedAt],
  ] : [['inline', record.commitMs, record.appliedAt]]
  const total = phases.reduce((sum, phase) => sum + (phase[1] ?? 0), 0)
  return el('section', { className: 'fc-lifecycle', 'aria-label': t('trace.lifecycle') },
    el('div', { className: 'fc-section-heading' }, el('h3', null, t('trace.lifecycle')), el('span', null, t('trace.notSpeedup'))),
    el('div', { className: 'fc-phases' }, phases.map(([name, ms], index) => el('div', { key: name, className: 'fc-phase' },
      el('span', { className: 'fc-phase-index' }, `0${index + 1}`),
      el('div', null, el('span', null, t(`trace.phase.${name}`)), el('strong', null, duration(ms)))))),
    el('div', { className: 'fc-timing-bar', 'aria-hidden': true }, phases.map(([name, ms]) => el('span', {
      key: name, 'data-phase': name, 'data-known': ms != null,
      style: { flex: total > 0 && ms != null ? Math.max(0.04, ms / total) : 0.08 },
    }))),
    el('p', { className: 'fc-note' }, t(background ? 'trace.timingHint' : 'trace.nativeTimingHint')))
}

function ResponseTiming({ record, t }) {
  const response = record.response
  if (!response && !appliedStates.has(record.status)) return null
  return el('section', { className: 'fc-response', 'aria-label': t('trace.response.title') },
    el('div', { className: 'fc-section-heading' }, el('h3', null, t('trace.response.title')),
      el('span', null, t(response ? `trace.response.status.${response.status}` : 'trace.response.unrecorded'))),
    response ? el('div', null,
      el('p', { className: 'fc-request-proof', 'data-verified': response.verified === true },
        t(response.verified ? 'trace.response.verified' : response.status === 'missing-checkpoint' ? 'trace.response.missing' : 'trace.response.unverified')),
      el('div', { className: 'fc-response-metrics' },
        el(Metric, { label: t('trace.response.blocking'), value: duration(response.blockingMs), note: t('trace.response.blockingHint') }),
        el(Metric, { label: t('trace.response.applied'), value: duration(response.afterApplyMs), note: t('trace.response.appliedHint') }),
        el(Metric, { label: t('trace.response.ttft'), value: duration(response.ttftMs), note: t('trace.response.ttftHint') })),
      el('div', { className: 'fc-response-kinds' }, ['Reasoning', 'Text', 'Tool'].map(kind => el('div', { key: kind },
        el('span', null, t(`trace.response.${kind.toLowerCase()}`)),
        el('strong', null, duration(response[`first${kind}Ms`]))))),
      response.firstKind && el('p', { className: 'fc-note' }, t('trace.response.firstKind'), ' ', t(`trace.response.kind.${response.firstKind}`)),
      response.warmupPrefix && el('p', { className: 'fc-note' }, t(`trace.warmupPrefix.${response.warmupPrefix}`)),
      response.trigger === 'manual' && el('p', { className: 'fc-note' }, t('trace.response.manual')),
      response.attempts?.length > 0 && el('details', { className: 'fc-attempts' },
        el('summary', null, t('trace.response.attempts'), ' · ', numeric(response.requestCount)),
        response.requestCount > response.attempts.length && el('p', { className: 'fc-note' }, t('trace.response.attemptLimit')),
        el('ol', null, response.attempts.map(attempt => el('li', { key: attempt.number },
          el('div', { className: 'fc-attempt-heading' }, el('span', null, `#${attempt.number}`, ' · ', time(attempt.startedAt)),
            el('span', null, t(`trace.response.status.${attempt.status}`)),
            el('span', { className: 'fc-mono' }, 'TTFT ', duration(attempt.ttftMs))),
          el('p', { className: 'fc-note' }, [attempt.provider, attempt.model, attempt.reasoningEffort].filter(Boolean).join(' / '),
            ' · ', t('trace.cacheRead'), ' ', numeric(attempt.usage?.cacheReadTokens)),
          attempt.error && el('pre', { className: 'fc-attempt-error' }, attempt.error))))))
      : el('p', { className: 'fc-note' }, t('trace.response.unrecordedHint')),
    el('p', { className: 'fc-note fc-response-note' }, t('trace.response.boundaryShort')),
    el('details', { className: 'fc-attempts' }, el('summary', null, t('trace.response.method')),
      el('p', { className: 'fc-note' }, t('trace.response.boundary'))))
}

function TraceDetail({ record, t }) {
  const [tab, setTab] = useState('summary')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  useEffect(() => { setCopied(false); setCopyError(false) }, [record.id, tab])
  const text = tab === 'original' ? record.original : record.summary
  const truncated = tab === 'original' ? record.originalTruncated : record.summaryTruncated
  const diagnostic = {
    id: record.id, mode: record.mode, status: record.status, reason: record.reason,
    provider: record.provider, model: record.model, range: record.range,
    startSeq: record.startSeq, summarySeq: record.summarySeq, checkpointSeq: record.checkpointSeq,
    startedAt: record.startedAt, appliedAt: record.appliedAt,
    generationMs: record.generationMs, waitMs: record.waitMs, commitMs: record.commitMs,
    inputTokens: record.inputTokens, outputTokens: record.outputTokens,
    contextUsage: record.contextUsage, summaryUsage: record.summaryUsage,
    contextWindow: record.contextWindow, reservedCompletion: record.reservedCompletion, inputLimit: record.inputLimit,
    eagerTokens: record.eagerTokens, thresholdTokens: record.thresholdTokens, waitTokens: record.waitTokens,
    usage: record.usage, summaryRequest: record.summaryRequest, warmup: record.warmup, error: record.error, response: record.response,
  }
  const body = tab === 'diagnostic' ? JSON.stringify(diagnostic, null, 2) : text
  const copy = async () => {
    try { await navigator.clipboard.writeText(body ?? ''); setCopied(true); setCopyError(false) }
    catch { setCopyError(true) }
  }
  return el('article', { className: 'fc-detail' },
    el('header', { className: 'fc-detail-head' },
      el('div', null, el('span', { className: 'fc-eyebrow' }, t(record.mode === 'background' ? 'trace.background' : 'trace.inline')),
        el('h2', null, t('trace.checkpoint'), ' ', el('span', { className: 'fc-id' }, record.id.slice(0, 8)))),
      el(Status, { record, t })),
    el('div', { className: 'fc-outcome', 'data-status': record.status },
      el('span', { className: 'fc-outcome-symbol', 'aria-hidden': true }, record.status === 'applied' ? '✓' : record.status === 'failed' ? '!' : '↳'),
      el('div', null, el('strong', null, t(`trace.outcome.${record.status}`)),
        el('p', null, record.reason ? t(`trace.reason.${record.reason}`) : t(`trace.explain.${record.status}`)))),
    el(ResponseTiming, { record, t }),
    el('div', { className: 'fc-detail-metrics' },
      el(Metric, { label: t('trace.contextActual'),
        value: `${numeric(record.contextUsage?.before?.inputTokens)} → ${numeric(record.contextUsage?.after?.inputTokens)}`,
        note: t(record.contextUsage?.afterStatus === 'pending' ? 'trace.contextPending'
          : record.contextUsage?.afterStatus === 'not-applied' ? 'trace.contextNotApplied'
          : record.contextUsage?.before?.inputTokens == null || record.contextUsage?.after?.inputTokens == null
            ? 'trace.contextUnavailable' : 'trace.contextMeasured') }),
      el(Metric, { label: t('trace.range'), value: record.range ? `#${record.range.start}–${record.range.end}` : '—',
        note: `${numeric(record.nodeCount)} ${t('trace.nodes')}` }),
      el(Metric, { label: t('trace.model'), value: record.model || '—', note: record.provider || t('trace.unknown') })),
    el('p', { className: 'fc-note' }, t('trace.contextHint')),
    el('div', { className: 'fc-detail-metrics' },
      el(Metric, { label: t('trace.summaryInput'), value: numeric(record.summaryUsage?.inputTokens), note: t('trace.summaryInputHint') }),
      el(Metric, { label: t('trace.summaryOutput'), value: numeric(record.summaryUsage?.outputTokens), note: t('trace.summaryOutputHint') }),
      el(Metric, { label: t('trace.summaryCacheRead'), value: numeric(record.summaryUsage?.cacheReadTokens), note: t('trace.reportedUsage') })),
    el('p', { className: 'fc-note' }, t('trace.spanEstimated'), ' ',
      el('span', { className: 'fc-mono' }, `${numeric(record.inputTokens)} → ${numeric(record.outputTokens)}`), ' · ', t('trace.spanEstimateHint')),
    el(Lifecycle, { record, t }),
    el('div', { className: 'fc-response-kinds' },
      el('div', null, el('span', null, t('trace.warmupCacheRead')), el('strong', null, numeric(record.warmup?.usage?.cacheReadTokens)))),
    record.summaryRequest && el('p', { className: 'fc-note' }, t('trace.summaryEffort'), ' ', record.summaryRequest.reasoningEffort ?? t('trace.providerDefault')),
    record.warmup && el('div', { className: 'fc-warmup', 'data-failed': record.warmup.status === 'failed' },
      el('span', null, t('trace.warmup')), el('strong', null, t(`trace.warmup.${record.warmup.status}`)),
      el('span', { className: 'fc-mono' }, duration(record.warmup.durationMs)),
      record.warmup.request && el('span', null, record.warmup.request.reasoningEffort ?? t('trace.providerDefault')),
      el('small', null, t(record.warmup.status === 'stale' ? 'trace.warmupStaleHint' : 'trace.warmupHint'))),
    (record.error || record.warmup?.error) && el('div', { className: 'fc-error-detail', role: 'note' },
      el('strong', null, t(record.error ? 'trace.error' : 'trace.warmupError')),
      el('pre', null, record.error || record.warmup.error)),
    el('section', { className: 'fc-content' },
      el('div', { className: 'fc-content-toolbar' },
        el('div', { className: 'fc-content-tabs', role: 'tablist', 'aria-label': t('trace.content') },
          ['summary', 'original', 'diagnostic'].map(key => el('button', { key, type: 'button', role: 'tab',
            id: `fc-tab-${key}`, 'aria-controls': 'fc-content-panel', 'aria-selected': key === tab,
            tabIndex: key === tab ? 0 : -1,
            onKeyDown: event => {
              const keys = ['summary', 'original', 'diagnostic']
              const index = keys.indexOf(tab)
              const next = event.key === 'ArrowRight' ? keys[(index + 1) % keys.length]
                : event.key === 'ArrowLeft' ? keys[(index + keys.length - 1) % keys.length]
                : event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : null
              if (!next) return
              event.preventDefault()
              setTab(next)
              event.currentTarget.parentElement.querySelector(`#fc-tab-${next}`).focus()
            },
            onClick: () => setTab(key) }, t(`trace.${key}`)))),
        el('button', { type: 'button', className: 'fc-copy', disabled: !body, onClick: copy },
          t(copied ? 'trace.copied' : 'trace.copy'))),
      copyError && el('p', { className: 'fc-note', role: 'status' }, t('trace.copyError')),
      el('div', { id: 'fc-content-panel', role: 'tabpanel', 'aria-labelledby': `fc-tab-${tab}`, tabIndex: 0 },
        body ? el('pre', { className: `fc-text ${tab === 'diagnostic' ? 'fc-json' : ''}` }, body)
          : el('div', { className: 'fc-content-empty' }, t(tab === 'summary' ? 'trace.noSummary' : 'trace.noOriginal')),
        truncated && tab !== 'diagnostic' && el('p', { className: 'fc-note' }, t('trace.truncated')))))
}

function TraceView({ readTrace, sessionId, t }) {
  const [state, setState] = useState({ sessionId, data: null, error: null, loading: true })
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let disposed = false, timer
    const controller = new AbortController()
    setState({ sessionId, data: null, error: null, loading: true })
    const poll = async () => {
      try {
        const result = await readTrace(controller.signal)
        if (!disposed) setState({ sessionId, data: result, error: null, loading: false })
      } catch (error) {
        if (!disposed) setState(previous => ({ ...previous, sessionId, error: error.message, loading: false }))
      } finally {
        if (!disposed) timer = setTimeout(poll, document.visibilityState === 'hidden' ? 10000 : 2500)
      }
    }
    void poll()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [sessionId, readTrace, refresh])
  const data = state.sessionId === sessionId ? state.data : null
  const records = data?.records ?? []
  const counts = { all: records.length, applied: records.filter(record => appliedStates.has(record.status)).length,
    pending: records.filter(record => liveStates.has(record.status)).length, issues: records.filter(problem).length }
  const visible = records.filter(record => (filter === 'all' || filter === 'applied' && appliedStates.has(record.status)
    || filter === 'pending' && liveStates.has(record.status) || filter === 'issues' && problem(record))
    && [record.id, record.summary, record.model, record.error].some(value => value?.toLowerCase().includes(query.toLowerCase())))
  const record = visible.find(record => record.id === selected) ?? visible[0]
  return el('div', { className: 'fc-trace', 'data-fc-trace': true },
    el('div', { className: 'fc-overview' },
      el(Metric, { label: t('trace.attempts'), value: numeric(records.length), note: t('trace.recent') }),
      el(Metric, { label: t('trace.inContext'), value: numeric(records.filter(record => record.status === 'applied').length), note: t('trace.inContextHint') }),
      el(Metric, { label: t('trace.waitTotal'), value: duration(records.reduce((sum, record) => sum + (record.waitMs ?? 0), 0)), note: t('trace.recordedOnly') })),
    state.error && el('div', { className: 'fc-banner', role: 'alert' }, el('strong', null, t('trace.loadError')), ' ', state.error,
      el('button', { type: 'button', onClick: () => setRefresh(value => value + 1) }, t('trace.retry'))),
    data?.integration?.status === 'native' && el('div', { className: 'fc-banner', role: 'status' }, t('trace.integrationNative'), ' ', data.integration.error ?? data.integration.reason),
    data?.integration?.budgetWarning && el('div', { className: 'fc-banner', role: 'status' }, t('trace.budgetUnknown')),
    data?.storageWarning && el('div', { className: 'fc-banner', role: 'status' }, t('trace.storageWarning'), ' ', data.storageWarning),
    el('div', { className: 'fc-filters' }, el('div', { className: 'fc-filter-group', 'aria-label': t('trace.filter') },
      ['all', 'applied', 'pending', 'issues'].map(key => el('button', { type: 'button', key, 'aria-pressed': filter === key,
        onClick: () => setFilter(key) }, t(`trace.filter.${key}`), el('span', null, counts[key])))),
      el('div', { className: 'fc-filter-actions' },
        el('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value),
          placeholder: t('trace.search'), 'aria-label': t('trace.search') }),
        el('button', { type: 'button', className: 'fc-refresh', onClick: () => setRefresh(value => value + 1),
          'aria-label': t('trace.refresh') }, el('span', { className: 'fc-live-dot', 'data-error': !!state.error }),
          t(state.loading ? 'trace.loading' : state.error ? 'trace.disconnected' : 'trace.live'), ' ↻'))),
    record ? el('div', { className: 'fc-workbench' },
      el('nav', { className: 'fc-records', 'aria-label': t('trace.records') }, visible.map(item => el('button', {
        key: item.id, type: 'button', className: 'fc-record', 'aria-current': record.id === item.id ? 'true' : undefined,
        onClick: () => setSelected(item.id),
      }, el('div', { className: 'fc-record-top' }, el('span', { className: 'fc-mono' }, time(item.startedAt)), el(Status, { record: item, t })),
      el('strong', null, t(item.mode === 'background' ? 'trace.background' : 'trace.inline')),
      el('div', { className: 'fc-record-bottom' }, el('span', null, item.range ? `#${item.range.start}–${item.range.end}` : item.id.slice(0, 8)),
        el('span', null, duration(item.generationMs ?? item.commitMs)))))),
      el(TraceDetail, { key: `${sessionId}/${record.id}`, record, t }))
      : el('div', { className: 'fc-empty' },
        el('svg', { viewBox: '0 0 128 72', width: 128, height: 72, fill: 'none', 'aria-hidden': true },
          el('path', { d: 'M12 18h34l22 18h48M12 54h34l22-18', stroke: 'currentColor', strokeWidth: 1.5 }),
          [12, 46, 82, 116].map((cx, index) => el('circle', { key: cx, cx, cy: index < 2 ? 18 : 36, r: 4, fill: 'var(--dsw-alias-bg-base)', stroke: 'currentColor', strokeWidth: 1.5 }))),
        el('h2', null, t(state.loading ? 'trace.loading' : state.error ? 'trace.loadError' : records.length ? 'trace.noMatches' : 'trace.empty')),
        el('p', null, t(state.error ? 'trace.retryHint' : records.length ? 'trace.noMatchesHint' : 'trace.emptyHint'))),
    el('footer', { className: 'fc-footer' }, el('span', null, t('trace.retention')), data && el('span', null, t('trace.updated'), ' ', time(data.sampledAt))))
}

module.exports = { TraceView, duration }
