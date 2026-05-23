import { createClient } from "npm:@supabase/supabase-js@2";
import { OpenAI } from "npm:openai@4";

// Environment Variables
const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is not set");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

// Initialize Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// Constants
const MAX_WORDS_PER_BATCH = 500;
const TOKEN_PER_WORD = 1.33;
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 5000;

// Interfaces
interface Chapter {
  index: number;
  title: string;
  part: string;
  word_count: number;
  summary: string;
  original_line: string;
}

// Utility Functions
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.ceil(words * TOKEN_PER_WORD);
}

async function withRetry<T>(operation: () => Promise<T>, retries = MAX_RETRIES, delay = INITIAL_RETRY_DELAY): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (
        ["429", "500", "503"].some(code => error.message.includes(code)) ||
        error.message.toLowerCase().includes("overloaded") ||
        error.name === "ConnectionError"
      ) {
        if (attempt < retries) {
          console.log(`Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError;
}

async function logError(functionName: string, message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from("error_logs")
      .insert({
        function_name: functionName,
        error_message: message,
        stack_trace: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error("Failed to log error to database:", dbError);
  } catch (err) {
    console.error("Error logging to database:", err);
  }
}

function parseOutlineText(outlineText: string): { chapters: Chapter[]; batchLines: string[]; totalWords: number; totalBatches: number } {
  const lines = outlineText.replace(/\r\n|\r/g, "\n").trim().split("\n").map(line => line.trim()).filter(line => line);
  let batchPlanStart = lines.findIndex(line => line.startsWith("Batch Plan:"));
  let batchLines: string[] = [];
  let chapters: Chapter[] = [];

  if (batchPlanStart === -1 || !lines.some(line => line.startsWith("- Batch"))) {
    throw new Error("Outline is truncated: missing or incomplete Batch Plan");
  }

  const chapterLines = batchPlanStart === -1 ? lines : lines.slice(0, batchPlanStart);
  chapters = chapterLines
    .filter(line => /^\d+\./.test(line))
    .map(line => {
      const match = line.match(/^(\d+)\.\s+(.+?)(?:\s*\(Part (\d+)\))?\s*-\s*(\d+)\s*words\s*:\s*(.+)$/i);
      if (!match) return null;
      return {
        index: parseInt(match[1]),
        title: match[2].trim(),
        part: match[3] ? `Part ${match[3]}` : "",
        word_count: parseInt(match[4]),
        summary: match[5].trim(),
        original_line: line,
      };
    })
    .filter((ch): ch is Chapter => ch !== null);

  const minBatches = Math.ceil(chapters.reduce((sum, ch) => sum + ch.word_count, 0) / MAX_WORDS_PER_BATCH);
  if (chapters.length < minBatches) {
    throw new Error(`Outline is incomplete: found ${chapters.length} chapters, expected at least ${minBatches}`);
  }

  if (batchPlanStart === -1) {
    console.warn("No batch plan found, generating default batch plan");
    batchLines = chapters.map((ch, i) => {
      const ref = ch.part ? `${ch.index} ${ch.part}` : `${ch.index}`;
      return `- Batch ${i + 1}: Chapters [${ref}], Total Words: ${ch.word_count}`;
    });
  } else {
    batchLines = lines.slice(batchPlanStart + 1).filter(line => line.startsWith("- Batch"));
  }

  const totalWords = chapters.reduce((sum, ch) => sum + ch.word_count, 0);
  const totalBatches = batchLines.length;
  return { chapters, batchLines, totalWords, totalBatches };
}

function validateOutline(outlineText: string, wordCount: number, minBatches: number): { isValid: boolean; outlineText: string } {
  let { chapters, batchLines, totalWords, totalBatches } = parseOutlineText(outlineText);
  let isValid = false;
  let newOutlineText = outlineText;

  const assignedChapters = new Set<string>();
  const batchWordCounts: number[] = [];
  let validReferences = true;
  const invalidReferences: string[] = [];

  for (const line of batchLines) {
    const match = line.match(/- Batch \d+: Chapters \[([^\]]*)\], Total Words: (\d+)/i);
    if (match) {
      const chaptersStr = match[1];
      const batchWords = parseInt(match[2]);
      batchWordCounts.push(batchWords);
      if (chaptersStr) {
        const refs = chaptersStr.split(",").map(ref => ref.trim()).filter(ref => ref);
        if (refs.length > 1) {
          validReferences = false;
          invalidReferences.push(`Multiple refs in ${line}`);
          continue;
        }
        for (const ref of refs) {
          const refMatch = ref.match(/(\d+)(?:\s*Part\s*(\d+))?/);
          if (refMatch) {
            const chapterNum = parseInt(refMatch[1]);
            const partNum = refMatch[2] ? `Part ${refMatch[2]}` : "";
            const found = chapters.some(ch => ch.index === chapterNum && ch.part === partNum);
            if (!found) {
              validReferences = false;
              invalidReferences.push(ref);
            } else {
              assignedChapters.add(`${chapterNum}${partNum ? " " + partNum : ""}`);
            }
          } else {
            validReferences = false;
            invalidReferences.push(ref);
          }
        }
      }
    } else {
      validReferences = false;
      invalidReferences.push(`Unparsable: ${line}`);
    }
  }

  const expectedBatches = Math.max(minBatches, chapters.length);
  isValid =
    totalWords >= wordCount &&
    totalWords <= wordCount + MAX_WORDS_PER_BATCH &&
    totalBatches >= minBatches &&
    !batchLines.some(line => line.includes("Chapters []")) &&
    assignedChapters.size >= chapters.length * 0.8 &&
    validReferences &&
    batchWordCounts.reduce((sum, w) => sum + w, 0) >= wordCount * 0.9 &&
    !batchWordCounts.some(w => w > MAX_WORDS_PER_BATCH) &&
    !chapters.some(ch => ch.title.toLowerCase().includes("placeholder") || ch.summary.toLowerCase().includes("placeholder"));

  console.log("Validation Check:", {
    totalWords,
    expectedWordCount: wordCount,
    totalBatches,
    minBatches,
    emptyBatches: batchLines.some(line => line.includes("Chapters []")),
    assignedChapters: assignedChapters.size,
    expectedAssigned: chapters.length,
    validReferences,
    invalidReferences,
    batchWordCountsSum: batchWordCounts.reduce((sum, w) => sum + w, 0),
    maxBatchWords: Math.max(...batchWordCounts, 0),
  });

  if (!isValid) {
    console.log("Initial plan invalid, redistributing chapters...");
    chapters.sort((a, b) => a.index - b.index || a.part.localeCompare(b.part));
    const newBatchPlan = chapters.map((ch, i) => {
      const ref = ch.part ? `${ch.index} ${ch.part}` : `${ch.index}`;
      return `- Batch ${i + 1}: Chapters [${ref}], Total Words: ${ch.word_count}`;
    });
    newOutlineText = chapters.map(ch => ch.original_line).join("\n") + "\n\nBatch Plan:\n" + newBatchPlan.join("\n");

    const { chapters: newChapters, batchLines: newBatchLines, totalWords: newTotalWords } = parseOutlineText(newOutlineText);
    const newAssignedChapters = new Set<string>();
    const newBatchWordCounts: number[] = [];
    let newValidReferences = true;
    const newInvalidReferences: string[] = [];

    for (const line of newBatchLines) {
      const match = line.match(/- Batch \d+: Chapters \[([^\]]*)\], Total Words: (\d+)/i);
      if (match) {
        const chaptersStr = match[1];
        const batchWords = parseInt(match[2]);
        newBatchWordCounts.push(batchWords);
        if (chaptersStr) {
          const refs = chaptersStr.split(",").map(ref => ref.trim()).filter(ref => ref);
          if (refs.length > 1) {
            newValidReferences = false;
            newInvalidReferences.push(`Multiple refs in ${line}`);
            continue;
          }
          for (const ref of refs) {
            const refMatch = ref.match(/(\d+)(?:\s*Part\s*(\d+))?/);
            if (refMatch) {
              const chapterNum = parseInt(refMatch[1]);
              const partNum = refMatch[2] ? `Part ${refMatch[2]}` : "";
              const found = newChapters.some(ch => ch.index === chapterNum && ch.part === partNum);
              if (!found) {
                newValidReferences = false;
                newInvalidReferences.push(ref);
              } else {
                newAssignedChapters.add(`${chapterNum}${partNum ? " " + partNum : ""}`);
              }
            } else {
              newValidReferences = false;
              newInvalidReferences.push(ref);
            }
          }
        }
      } else {
        newValidReferences = false;
        newInvalidReferences.push(`Unparsable: ${line}`);
      }
    }

    isValid =
      newTotalWords >= wordCount &&
      newTotalWords <= wordCount + MAX_WORDS_PER_BATCH &&
      newBatchLines.length >= minBatches &&
      !newBatchLines.some(line => line.includes("Chapters []")) &&
      newAssignedChapters.size >= newChapters.length * 0.8 &&
      newValidReferences &&
      newBatchWordCounts.reduce((sum, w) => sum + w, 0) === newTotalWords &&
      !newBatchWordCounts.some(w => w > MAX_WORDS_PER_BATCH);

    console.log("Redistribution Validation Check:", {
      newTotalWords,
      expectedWordCount: wordCount,
      newBatchCount: newBatchLines.length,
      minBatches,
      emptyBatches: newBatchLines.some(line => line.includes("Chapters []")),
      newAssignedChapters: newAssignedChapters.size,
      expectedAssigned: newChapters.length,
      newValidReferences,
      newInvalidReferences,
      newBatchWordCountsSum: newBatchWordCounts.reduce((sum, w) => sum + w, 0),
      maxBatchWords: Math.max(...newBatchWordCounts, 0),
    });
  }

  return { isValid, outlineText: newOutlineText };
}

async function processJob() {
  const { data: job, error } = await supabase
    .from("story_tasks")
    .select("*")
    .eq("status", "pending")
    .limit(1)
    .single();

  if (error || !job) {
    console.log("No pending jobs found or error:", error);
    return;
  }

  try {
    const { story_title: title, description, total_word_count: wordCount } = job;
    const minBatches = Math.ceil(wordCount / MAX_WORDS_PER_BATCH);

    const systemPrompt = wordCount < 3000
      ? `You are an expert story planner. Create a detailed outline for a short story with the given title, description, and total word count (under 3000 words). Follow these steps:

1. Divide the story into at least 2 chapters or chapter parts. Each chapter or part must have a unique, descriptive title, a target word count, and a detailed summary including specific plot points, character moments, and thematic elements. Ensure the structure is simple and natural for a shorter story.
2. The total word count for all chapters MUST sum to EXACTLY ${wordCount} words. This is critical and non-negotiable.
3. If a chapter’s word count exceeds ${MAX_WORDS_PER_BATCH} words, split it into parts (e.g., a 1000-word chapter must be split into two parts, such as 500 words each, with appropriate summaries). Each part must be listed as a separate chapter with its own index (e.g., '4. Chapter Title (Part 1)', '5. Chapter Title (Part 2)').
4. Assign each chapter or chapter part to its own batch, so the number of batches equals the number of chapters or parts. Each batch MUST NOT exceed ${MAX_WORDS_PER_BATCH} words. Ensure the total words across batches equals ${wordCount}.
5. Format the outline strictly as follows, with no extra formatting, bolding, Markdown symbols (e.g., ** or *), or additional commentary beyond the chapters and batch plan. Do not include placeholder chapters or summaries (e.g., no titles like "Placeholder Chapter" or summaries like "Placeholder summary"):

1. Chapter Title - WordCount words: Summary
2. Chapter Title (Part 1) - WordCount words: Summary
3. Chapter Title (Part 2) - WordCount words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: WordCount
- Batch 2: Chapters [2 Part 1], Total Words: WordCount
- Batch 3: Chapters [3 Part 2], Total Words: WordCount
(etc.)

Example:
1. The Encounter - 500 words: Soldiers spot a mysterious figure in the jungle, their radios failing as tension rises.
2. The Escape (Part 1) - 400 words: The team flees under pressure, navigating dense terrain while hearing unnatural sounds.
3. The Escape (Part 2) - 400 words: They evade an unseen threat, discovering strange markings on the trees.
4. No One Listens - 500 words: The survivors reach the extraction point, but their warnings are ignored by command.

Batch Plan:
- Batch 1: Chapters [1], Total Words: 500
- Batch 2: Chapters [2 Part 1], Total Words: 400
- Batch 3: Chapters [3 Part 2], Total Words: 400
- Batch 4: Chapters [4], Total Words: 500

Ensure the batch plan assigns each chapter or part to exactly one batch, with each batch ≤ ${MAX_WORDS_PER_BATCH} words, and the total words across batches EXACTLY equals ${wordCount}. Each chapter or part must be referenced correctly in the batch plan using its outline index (e.g., "2 Part 1" for chapter 2, "3 Part 2" for chapter 3). Do not include notes, alternative plans, placeholders, or text beyond the required format.`
      : `You are an expert story planner. Create a detailed outline for a novel with the given title, description, and total word count. The most critical requirement is to produce AT LEAST ${minBatches} batches, each containing EXACTLY ONE chapter or chapter part with a word count ≤ ${MAX_WORDS_PER_BATCH} words, summing to AT LEAST ${wordCount} words. Follow these steps exactly:

1. Plan a cohesive story arc covering AT LEAST ${wordCount} words, with a clear beginning, middle, and end. Divide the story into at least ${minBatches} chapter parts, each with a unique, descriptive title and a detailed summary including specific plot points, character moments, and thematic elements. For the story of Hercules, ensure the outline covers his birth, Hera's wrath, all Twelve Labors, and his ascension to godhood.
2. Assign each chapter a word count. If a chapter's word count exceeds ${MAX_WORDS_PER_BATCH} words, split it into parts (e.g., a 1200-word chapter into two 500-word parts or three 400-word parts). Each part's word count MUST be 300, 400, or 500 words. Each part must be listed as a separate chapter with its own index (e.g., '4. Chapter Title (Part 1)', '5. Chapter Title (Part 2)').
3. In the outline, list ONLY the chapters (if ≤ ${MAX_WORDS_PER_BATCH} words) or chapter parts (e.g., "Chapter Title (Part 1)"), not parent chapters. The total word count of all listed chapters/parts MUST sum to AT LEAST ${wordCount} words.
4. Assign each chapter or part to its own batch, ensuring AT LEAST ${minBatches} batches. Each batch MUST contain EXACTLY ONE chapter or part, with a word count ≤ ${MAX_WORDS_PER_BATCH} words. The total word count across batches MUST equal the sum of listed chapters/parts.
5. Format the outline exactly as follows, with no extra formatting, bolding, Markdown symbols, or commentary. List only chapters or chapter parts with their word counts and summaries. Do not include placeholder chapters or summaries. Ensure the outline is complete and not truncated:

1. Chapter Title - WordCount words: Summary
2. Chapter Title (Part 1) - WordCount words: Summary
3. Chapter Title (Part 2) - WordCount words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: WordCount
- Batch 2: Chapters [2 Part 1], Total Words: WordCount
- Batch 3: Chapters [3 Part 2], Total Words: WordCount
(etc.)

Example:
1. The Encounter (Part 1) - 500 words: Soldiers track a mysterious figure in the jungle, finding eerie symbols carved into trees. Fear grips them as night falls.
2. The Encounter (Part 2) - 500 words: An ambush forces a desperate escape, with unnatural sounds echoing in the dark.
3. No One Listens - 500 words: The survivors reach the extraction point, but their warnings are ignored by command.

Batch Plan:
- Batch 1: Chapters [1 Part 1], Total Words: 500
- Batch 2: Chapters [2 Part 2], Total Words: 500
- Batch 3: Chapters [3], Total Words: 500

Ensure the batch plan assigns each chapter or part to EXACTLY ONE batch, with AT LEAST ${minBatches} batches, each ≤ ${MAX_WORDS_PER_BATCH} words, and the total words across batches matches the sum of listed chapters/parts. Each chapter or part must be referenced correctly using its outline index (e.g., "2 Part 1" for chapter 2, "3 Part 2" for chapter 3). Plan the full novel upfront, generating enough chapters/parts to meet the batch and word count requirements without truncation. Do not include notes, alternative plans, placeholders, or text beyond the required format.`;

    let outlineText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= 5; attempt++) {
      console.log(`Attempt ${attempt} to generate outline for job ${job.id}`);
      const startTime = Date.now();
      const response = await withRetry(
        () =>
          openai.chat.completions.create({
            model: "deepseek-chat",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `Create an outline for:\nTitle: ${title}\nDescription: ${description}\nTotal Words: ${wordCount}. Make sure you write at least ${minBatches} parts to reach at least ${wordCount} words in total.` },
            ],
            max_tokens: 8100,
            temperature: 0.8 + (attempt - 1) * 0.05,
          }),
        5,
        5000
      );
      console.log(`DeepSeek API response time for attempt ${attempt}: ${Date.now() - startTime}ms`);

      const text = response.choices[0]?.message.content || "";
      inputTokens = response.usage?.prompt_tokens || estimateTokens(systemPrompt + `Create an outline for:\nTitle: ${title}\nDescription: ${description}\nTotal Words: ${wordCount}. Make sure you write at least ${minBatches} parts to reach at least ${wordCount} words in total.`);
      outputTokens = response.usage?.completion_tokens || estimateTokens(text);

      console.log(`Raw Outline Attempt ${attempt}:\n${text}\n`);

      try {
        const { isValid, outlineText: validatedText } = validateOutline(text, wordCount, minBatches);
        if (isValid) {
          outlineText = validatedText;
          console.log(`Attempt ${attempt}: Valid outline generated.`);
          break;
        }
        console.log(`Attempt ${attempt}: Invalid outline, retrying...`);
      } catch (error: any) {
        console.log(`Attempt ${attempt}: Outline processing failed: ${error.message}`);
        if (attempt === 5) {
          throw new Error(`Failed to generate a valid outline after ${attempt} attempts: ${error.message}`);
        }
      }
    }

    if (!outlineText) {
      throw new Error("Failed to generate a valid outline after all retries");
    }

    const parseSystemPrompt = `You are an expert text parser. Given the story outline below, parse it into a structured JSON object with two keys: 'chapters' and 'batches'. The 'chapters' key should map to an array of chapter objects, each with 'number' (integer), 'title' (string), 'part' (string, e.g., "Part 1" or "" if not split), 'word_count' (integer), and 'summary' (string) keys. The 'batches' key should map to an array of batch objects, each with 'batch_number' (integer), 'chapter_identifiers' (array of strings, e.g., ["1", "2 Part 1"]), and 'total_words' (integer). The outline format will be:

1. Chapter Title - WordCount words: Summary text...
2. Chapter Title (Part 1) - WordCount words: Summary text...
3. Chapter Title (Part 2) - WordCount words: Summary text...
(etc.)

Batch Plan:
- Batch 1: Chapters [list of chapter numbers or chapter parts, e.g., "1", "2 Part 1"], Total Words: WordCount
- Batch 2: Chapters [list of chapter numbers or chapter parts], Total Words: WordCount
(etc.)

Extract the chapter number, title, part (if any), word count, and summary from each chapter line. For the batch plan, assign each chapter or part to exactly one batch, ensuring each batch contains EXACTLY ONE chapter or part. The 'chapter_identifiers' should match the chapter's number and part (e.g., "2" for chapter 2 with no part, "3 Part 1" for chapter 3 part 1). Ensure the total words per batch do not exceed ${MAX_WORDS_PER_BATCH}. Return only the JSON object, nothing else. Example output:

{
    "chapters": [
        {"number": 1, "title": "Chapter Title", "part": "", "word_count": 500, "summary": "Summary text..."},
        {"number": 2, "title": "Another Title", "part": "Part 1", "word_count": 500, "summary": "Part 1 summary..."},
        {"number": 2, "title": "Another Title", "part": "Part 2", "word_count": 500, "summary": "Part 2 summary..."}
    ],
    "batches": [
        {"batch_number": 1, "chapter_identifiers": ["1"], "total_words": 500},
        {"batch_number": 2, "chapter_identifiers": ["2 Part 1"], "total_words": 500},
        {"batch_number": 3, "chapter_identifiers": ["2 Part 2"], "total_words": 500}
    ]
}`;

    const parseStartTime = Date.now();
    let parsedData;
    try {
      const parseResponse = await withRetry(
        () =>
          openai.chat.completions.create({
            model: "deepseek-chat",
            messages: [
              { role: "system", content: parseSystemPrompt },
              { role: "user", content: `Parse this outline:\n${outlineText}` },
            ],
            max_tokens: 8100,
            temperature: 0.8,
          }),
        5,
        5000
      );
      console.log(`DeepSeek API parse response time: ${Date.now() - parseStartTime}ms`);

      let jsonOutput = parseResponse.choices[0]?.message.content || "";
      console.log("Raw DeepSeek parse response:", jsonOutput);

      jsonOutput = jsonOutput.trim();
      if (jsonOutput.startsWith("```json")) jsonOutput = jsonOutput.slice(7);
      if (jsonOutput.endsWith("```")) jsonOutput = jsonOutput.slice(0, -3);
      jsonOutput = jsonOutput.trim();

      parsedData = JSON.parse(jsonOutput);
      if (!parsedData.chapters || !Array.isArray(parsedData.chapters)) {
        throw new Error("Missing or invalid chapters array");
      }
      if (!parsedData.batches || !Array.isArray(parsedData.batches)) {
        throw new Error("Missing or invalid batches array");
      }

      for (const chapter of parsedData.chapters) {
        if (!chapter.number || !chapter.title || typeof chapter.word_count !== "number" || !chapter.summary) {
          throw new Error("Invalid chapter format");
        }
        chapter.number = parseInt(chapter.number);
        chapter.part = chapter.part || "";
        chapter.word_count = parseInt(chapter.word_count);
      }

      const assignedIdentifiers = new Set<string>();
      const invalidIdentifiers: string[] = [];
      for (const batch of parsedData.batches) {
        batch.batch_number = parseInt(batch.batch_number);
        batch.total_words = parseInt(batch.total_words);
        if (batch.total_words > MAX_WORDS_PER_BATCH) {
          throw new Error(`Batch ${batch.batch_number} exceeds ${MAX_WORDS_PER_BATCH} words: ${batch.total_words}`);
        }
        if (batch.chapter_identifiers.length !== 1) {
          console.warn(`Batch ${batch.batch_number} has ${batch.chapter_identifiers.length} identifiers, expected 1: ${JSON.stringify(batch.chapter_identifiers)}`);
          batch.chapter_identifiers = [];
        }
        for (const identifier of batch.chapter_identifiers) {
          const match = identifier.match(/^(\d+)(?:\sPart\s(\d+))?$/);
          if (!match) {
            invalidIdentifiers.push(identifier);
            continue;
          }
          const chapterNum = parseInt(match[1]);
          const part = match[2] ? `Part ${match[2]}` : "";
          const found = parsedData.chapters.some(ch => ch.number === chapterNum && ch.part === part);
          if (!found) invalidIdentifiers.push(identifier);
          else assignedIdentifiers.add(identifier);
        }
      }

      if (invalidIdentifiers.length > 0 || assignedIdentifiers.size < parsedData.chapters.length * 0.8) {
        console.log("Redistributing batches due to invalid identifiers or insufficient assignments");
        parsedData.batches = parsedData.chapters.map((chapter: any, index: number) => {
          const identifier = chapter.part ? `${chapter.number} ${chapter.part}` : `${chapter.number}`;
          return {
            batch_number: index + 1,
            chapter_identifiers: [identifier],
            total_words: chapter.word_count,
          };
        });
      }

      console.log(`Parsed ${parsedData.chapters.length} chapters and ${parsedData.batches.length} batches.`);
    } catch (error: any) {
      await logError("parseOutline", "Failed to parse outline", error);
      throw new Error(`Failed to parse outline: ${error.message}`);
    }

    const { totalBatches } = parseOutlineText(outlineText);
    await supabase
      .from("story_tasks")
      .update({
        status: "completed",
        outline: outlineText,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_batches: totalBatches,
        settings: parsedData,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
  } catch (error: any) {
    await logError("processJob", "Failed to process job", error);
    await supabase
      .from("story_tasks")
      .update({
        status: "error",
        error: error.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
  }
}

// Poll for jobs every 10 seconds
console.log("Worker started, polling for jobs...");
setInterval(processJob, 10000);
