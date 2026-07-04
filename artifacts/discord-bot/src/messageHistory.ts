const MAX_ENTRIES = 10;
const MAX_ENTRY_LEN = 400;

interface HistoryEntry {
  username: string;
  content: string;
}

const histories = new Map<string, HistoryEntry[]>();

export function addToHistory(channelId: string, username: string, content: string): void {
  const hist = histories.get(channelId) ?? [];
  hist.push({ username, content: content.slice(0, MAX_ENTRY_LEN) });
  if (hist.length > MAX_ENTRIES) hist.shift();
  histories.set(channelId, hist);
}

export function getHistory(channelId: string): HistoryEntry[] {
  return histories.get(channelId) ?? [];
}

export function clearHistory(channelId: string): void {
  histories.delete(channelId);
}
