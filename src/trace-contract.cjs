// Shared, explicit Typert contract. Transport stays inside DSH's authenticated gateway.
const traceDescriptor = {
  id: 'dsh-faster-compress#trace.read',
  service: 'fasterCompressTrace', namespace: 'fasterCompressTrace', method: 'read',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: {
    mode: 'strict', typeSymbol: 'dsh-faster-compress#SessionId',
    create: () => ({ parse(value) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('Invalid session id')
      return value
    } }),
  } }],
  cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
}
module.exports = { traceDescriptor }
