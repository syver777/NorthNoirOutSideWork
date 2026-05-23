const TAVILY_API_KEY = Deno.env.get('TAVILY_KEY') ?? '';
const TAVILY_API_URL = 'https://api.tavily.com/search';

// Tavily basic search cost: $0.008/credit, with 20% margin = $0.0096
// At $2/1M tokens user rate, expressed as output-token-equivalents (1:1 weight in billing)
export const TAVILY_SEARCH_TOKEN_COST = 4800;

export interface TavilySearchResult {
  context: string;
  creditsUsed: number;
}

export async function searchTopicContext(
  storyTitle: string,
  chapterTitles: string[],
  contentType: string
): Promise<TavilySearchResult> {
  // Only search for non-story content types
  if (contentType === 'story' || !TAVILY_API_KEY) {
    return { context: '', creditsUsed: 0 };
  }

  try {
    const chapterContext = chapterTitles.slice(0, 3).join(', ');
    const query = `${storyTitle}: ${chapterContext}`;

    console.log(`Tavily search for ${contentType}: "${query.slice(0, 100)}..."`);

    const response = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: 'basic',
        topic: 'general',
        include_usage: true,
      }),
    });

    if (!response.ok) {
      console.error(`Tavily search failed: ${response.status} ${response.statusText}`);
      return { context: '', creditsUsed: 0 };
    }

    const data = await response.json();
    const creditsUsed = data.usage?.credits || 1;

    let context = '\n\n=== WEB RESEARCH DATA (VERIFIED SOURCES) ===\n';
    context += 'The following data was gathered from real web sources. Use these facts where relevant to the current chapters.\n\n';

    if (data.answer) {
      context += `Summary: ${data.answer}\n\n`;
    }

    if (data.results && data.results.length > 0) {
      for (const result of data.results) {
        if (result.content) {
          context += `Source: ${result.title || 'Unknown'}\n${result.content}\n\n`;
        }
      }
    }

    context += '=== END WEB RESEARCH DATA ===';

    console.log(`Tavily search returned ${data.results?.length || 0} results, ${creditsUsed} credits used`);
    return { context, creditsUsed };
  } catch (error: any) {
    console.error(`Tavily search error: ${error.message}`);
    return { context: '', creditsUsed: 0 };
  }
}
