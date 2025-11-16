export const extractAnswerText = (sseChunk: string): string[] => {
  if (!sseChunk) return [];
  const blocks = sseChunk.split('\n\n');
  const results: string[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    let eventName: string | null = null;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5));
      }
    }

    if (eventName === 'answer' && dataLines.length > 0) {
      const raw = dataLines.join('\n').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') {
          results.push(parsed);
        } else {
          results.push(JSON.stringify(parsed));
        }
      } catch {
        results.push(raw);
      }
    }
  }

  return results;
};
