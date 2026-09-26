/**
 * What each AI-adjacent capability can do on this deployment
 * (API_CONTRACT.md §9.10 GET /ai/capabilities). The answer is derived from
 * configuration and the adapters that actually exist, never assumed.
 * IFRSmart ships no language-model adapter: with or without a configured
 * provider, the assistant and insight narrative run their deterministic paths
 * and say so.
 */

export function describeCapabilities({ config, documentReader }) {
  const provider = config.ai.enabled ? config.ai.provider : null;
  const noLanguageModel = provider
    ? `AI provider "${provider}" is configured, but no language-model adapter exists for it in IFRSmart.`
    : 'No AI provider is configured.';
  const reader = documentReader.capability();
  return {
    provider: provider ?? null,
    capabilities: [
      { id: 'document_extraction', method: reader.method, available: reader.available, degraded: !reader.available, note: reader.note },
      { id: 'categorization', method: 'rule', available: true, degraded: false, note: 'Owner rules and learned corrections, then Uncategorized. No AI model.' },
      { id: 'insights', method: 'rule', available: true, degraded: true, note: `Findings are calculated with fixed rules. Narrative generation is unavailable: ${noLanguageModel}` },
      { id: 'anomaly_detection', method: 'statistics', available: true, degraded: false, note: 'Deterministic rules and robust statistics over your own history.' },
      { id: 'forecast', method: 'statistics', available: true, degraded: false, note: 'Deterministic projection; not an AI prediction.' },
      { id: 'financial_health', method: 'rule', available: true, degraded: false, note: 'Fixed thresholds over your own figures.' },
      { id: 'assistant', method: 'rule', available: true, degraded: true, note: `Answers common questions from your figures with a deterministic matcher. Open-ended questions are unavailable: ${noLanguageModel}` },
    ],
  };
}

/** The assistant's capability disclosure. */
export function assistantCapability(config) {
  const [assistant] = describeCapabilities({ config, documentReader: { capability: () => ({}) } }).capabilities.filter((c) => c.id === 'assistant');
  return { method: 'rule', confidence: null, degraded: true, note: assistant.note };
}
