/**
 * Unit & Invariant Tests for Whisper Prompt, Hotwords, Post-Processing & Subtitle Merging
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('================================================================');
console.log('   RUNNING WHISPER PROMPT, POST-PROCESS & MERGE TEST SUITE      ');
console.log('================================================================');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

// Bundle TypeScript modules via esbuild for testing
const bundle = await esbuild.build({
  stdin: {
    contents: `
      export * from './electron/whisperPrompt.ts';
      export * from './electron/whisperPostProcess.ts';
      export { cleanSubtitleSrt } from './electron/whisper.ts';
    `,
    resolveDir: process.cwd(),
    sourcefile: 'test-whisper-prompt-entry.ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  external: [
    'electron',
    'fs',
    'path',
    'child_process',
    'crypto',
    'http',
    'url',
    'os',
    'events',
  ],
  plugins: [
    {
      name: 'mock-electron',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => {
          return { path: path.join(process.cwd(), 'test-mock-electron.js') };
        });
      },
    },
  ],
});

const tmpBundlePath = path.join(process.cwd(), '.test_whisper_prompt_bundle.mjs');
fs.writeFileSync(tmpBundlePath, bundle.outputFiles[0].text);

let testedModules;
try {
  testedModules = await import(pathToFileURL(tmpBundlePath).href);
} finally {
  try {
    fs.unlinkSync(tmpBundlePath);
  } catch {}
}

const {
  normalizeCharacter,
  prioritizeCharacters,
  estimateWhisperTokens,
  buildInitialPrompt,
  buildHotwords,
  buildFullCharacterNameList,
  AMBIGUOUS_ANIME_NAMES,
  correctCharacterSpellings,
  filterHallucinations,
  mergeIsolatedSingleWords,
  balanceSubtitleLines,
  similarityRatio,
  levenshteinDistance,
  COMMON_ENGLISH_WORDS,
  cleanSubtitleSrt,
} = testedModules;

// ================================================================
// SUITE 1: Normalization of API Character Data
// ================================================================
console.log('\n--- TEST SUITE 1: Normalization of API Data ---');

runTest('1.1 Strips parentheses and voice actor / narrator tags', () => {
  const edge = {
    role: 'MAIN',
    node: { name: { full: 'Haruhi Suzumiya (Young)', first: 'Haruhi', last: 'Suzumiya' } },
  };
  const norm = normalizeCharacter(edge);
  assert.strictEqual(norm.fullName, 'Haruhi Suzumiya');
  assert.strictEqual(norm.spokenName, 'Haruhi');
  assert.strictEqual(norm.role, 'MAIN');
});

runTest('1.2 Strips honorifics (-san, -kun, -senpai, etc.)', () => {
  const edge = {
    role: 'SUPPORTING',
    node: { name: { full: 'Tsuruya-san', first: 'Tsuruya' } },
  };
  const norm = normalizeCharacter(edge);
  assert.strictEqual(norm.fullName, 'Tsuruya');
  assert.strictEqual(norm.spokenName, 'Tsuruya');
});

runTest('1.3 Strips formal titles (Captain, Dr., Professor)', () => {
  const edge = {
    role: 'MAIN',
    node: { name: { full: 'Captain Levi Ackerman', first: 'Levi', last: 'Ackerman' } },
  };
  const norm = normalizeCharacter(edge);
  assert.strictEqual(norm.fullName, 'Levi Ackerman');
  assert.strictEqual(norm.spokenName, 'Levi');
});

runTest('1.4 Reverses Japanese surname-first order (Yeager Eren -> Eren Yeager)', () => {
  const edge = {
    role: 'MAIN',
    node: { name: { full: 'Yeager Eren', first: 'Eren', last: 'Yeager' } },
  };
  const norm = normalizeCharacter(edge);
  assert.strictEqual(norm.fullName, 'Eren Yeager');
  assert.strictEqual(norm.spokenName, 'Eren');
});

runTest('1.5 Normalizes comma-separated names (Ackerman, Mikasa -> Mikasa Ackerman)', () => {
  const edge = {
    role: 'MAIN',
    node: { name: { full: 'Ackerman, Mikasa', first: 'Mikasa', last: 'Ackerman' } },
  };
  const norm = normalizeCharacter(edge);
  assert.strictEqual(norm.fullName, 'Mikasa Ackerman');
  assert.strictEqual(norm.spokenName, 'Mikasa');
});

runTest('1.6 Drops Japanese description entries (Kyon no Imouto, Tanaka no Haha)', () => {
  const edge = {
    role: 'SUPPORTING',
    node: { name: { full: 'Kyon no Imouto' } },
  };
  const norm = normalizeCharacter(edge);
  assert.strictEqual(norm, null, 'Must drop Kyon no Imouto');
});

runTest('1.7 Drops English relation descriptions (Hero\'s sister, Eren\'s mother)', () => {
  const edge = {
    role: 'SUPPORTING',
    node: { name: { full: "Eren's mother" } },
  };
  const norm = normalizeCharacter(edge);
  assert.strictEqual(norm, null, 'Must drop possessive descriptions');
});

runTest('1.8 Drops generic background roles and extras (Townsperson, Villager A, Male Student)', () => {
  const genericList = ['Townsperson A', 'Villager 1', 'Male Student', 'Female Teacher', 'Narrator', 'Guard A'];
  for (const title of genericList) {
    const edge = { role: 'BACKGROUND', node: { name: { full: title } } };
    assert.strictEqual(normalizeCharacter(edge), null, `Must drop generic role "${title}"`);
  }
});

runTest('1.9 Drops pets / animals (Shamisen, Ein)', () => {
  const edge = {
    role: 'SUPPORTING',
    node: { name: { full: 'Shamisen' } },
  };
  assert.strictEqual(normalizeCharacter(edge), null, 'Must drop pet Shamisen');
});

// ================================================================
// SUITE 2: Priority, Filtering & Ambiguous Name Handling
// ================================================================
console.log('\n--- TEST SUITE 2: Priority Order & Ambiguous Names ---');

runTest('2.1 MAIN characters prioritized before SUPPORTING; BACKGROUND completely skipped', () => {
  const edges = [
    { role: 'BACKGROUND', node: { name: { full: 'Episodic Guy', first: 'Guy' } } },
    { role: 'SUPPORTING', node: { name: { full: 'Itsuki Koizumi', first: 'Itsuki', last: 'Koizumi' } } },
    { role: 'MAIN', node: { name: { full: 'Haruhi Suzumiya', first: 'Haruhi', last: 'Suzumiya' } } },
    { role: 'MAIN', node: { name: { full: 'Kyon', first: 'Kyon' } } },
  ];
  const prioritized = prioritizeCharacters(edges);
  assert.strictEqual(prioritized.length, 3, 'Must filter out BACKGROUND character');
  assert.strictEqual(prioritized[0].fullName, 'Haruhi Suzumiya');
  assert.strictEqual(prioritized[1].fullName, 'Kyon');
  assert.strictEqual(prioritized[2].fullName, 'Itsuki Koizumi');
});

runTest('2.2 Ambiguous names (Light, Ray, May, Rose) pushed to the end of the candidate list', () => {
  const edges = [
    { role: 'MAIN', node: { name: { full: 'Light Yagami', first: 'Light', last: 'Yagami' } } },
    { role: 'MAIN', node: { name: { full: 'Misa Amane', first: 'Misa', last: 'Amane' } } },
    { role: 'MAIN', node: { name: { full: 'Ryuk', first: 'Ryuk' } } },
  ];
  const prioritized = prioritizeCharacters(edges);
  // Non-ambiguous Misa and Ryuk must come before ambiguous Light
  assert.strictEqual(prioritized[0].fullName, 'Misa Amane');
  assert.strictEqual(prioritized[1].fullName, 'Ryuk');
  assert.strictEqual(prioritized[2].fullName, 'Light Yagami');
  assert.strictEqual(prioritized[2].isAmbiguous, true);
});

// ================================================================
// SUITE 3: Length Trimming & Token Budget
// ================================================================
console.log('\n--- TEST SUITE 3: Length Trimming & Token Budget ---');

runTest('3.1 Full names used for top ~3 characters, spoken names used for rank 4+', () => {
  const edges = [
    { role: 'MAIN', node: { name: { full: 'Haruhi Suzumiya', first: 'Haruhi', last: 'Suzumiya' } } },
    { role: 'MAIN', node: { name: { full: 'Mikuru Asahina', first: 'Mikuru', last: 'Asahina' } } },
    { role: 'MAIN', node: { name: { full: 'Itsuki Koizumi', first: 'Itsuki', last: 'Koizumi' } } },
    { role: 'MAIN', node: { name: { full: 'Yuki Nagato', first: 'Yuki', last: 'Nagato' } } },
    { role: 'SUPPORTING', node: { name: { full: 'Ryoko Asakura', first: 'Ryoko', last: 'Asakura' } } },
  ];
  const chars = prioritizeCharacters(edges);
  const prompt = buildInitialPrompt(chars);

  // Top 3 full names
  assert.ok(prompt.includes('Haruhi Suzumiya'), 'Top 1 must have full name');
  assert.ok(prompt.includes('Mikuru Asahina'), 'Top 2 must have full name');
  assert.ok(prompt.includes('Itsuki Koizumi'), 'Top 3 must have full name');
  // Rank 4+ spoken names
  assert.ok(prompt.includes('Yuki'), 'Rank 4 must have spoken name (Yuki)');
  assert.ok(!prompt.includes('Yuki Nagato'), 'Rank 4 must NOT use full name Nagato');
  assert.ok(prompt.includes('Ryoko'), 'Rank 5 must have spoken name (Ryoko)');
  assert.ok(!prompt.includes('Ryoko Asakura'), 'Rank 5 must NOT use full name Asakura');
});

runTest('3.2 Strict token budget (<= 180 tokens) enforced even with 30 characters', () => {
  const edges = [];
  for (let i = 1; i <= 30; i++) {
    edges.push({
      role: i <= 10 ? 'MAIN' : 'SUPPORTING',
      node: {
        name: {
          full: `CharacterLastName${i} CharacterFirstName${i}`,
          first: `CharacterFirstName${i}`,
          last: `CharacterLastName${i}`,
        },
      },
    });
  }
  const chars = prioritizeCharacters(edges, 30);
  const prompt = buildInitialPrompt(chars, { maxTokens: 180 });
  const tokens = estimateWhisperTokens(prompt);
  assert.ok(tokens <= 180, `Tokens (${tokens}) must be <= 180`);
  assert.ok(prompt.startsWith('Dialogue from an anime episode. Characters: '));
  assert.ok(prompt.endsWith('.'));
});

runTest('3.3 No instruction-like phrases (clean subtitles, conversational speech) in initial prompt', () => {
  const edges = [
    { role: 'MAIN', node: { name: { full: 'Eren Yeager', first: 'Eren', last: 'Yeager' } } },
  ];
  const chars = prioritizeCharacters(edges);
  const prompt = buildInitialPrompt(chars);
  assert.ok(!prompt.includes('clean subtitles'), 'No "clean subtitles" command');
  assert.ok(!prompt.includes('conversational speech'), 'No "conversational speech" command');
  assert.ok(!prompt.includes('Anime dialogue,'), 'No style instruction');
  assert.strictEqual(prompt, 'Dialogue from an anime episode. Characters: Eren Yeager.');
});

runTest('3.4 Hotwords generated as comma-separated string for top 10-15 characters', () => {
  const edges = [
    { role: 'MAIN', node: { name: { full: 'Haruhi Suzumiya', first: 'Haruhi', last: 'Suzumiya' } } },
    { role: 'MAIN', node: { name: { full: 'Mikuru Asahina', first: 'Mikuru', last: 'Asahina' } } },
    { role: 'MAIN', node: { name: { full: 'Itsuki Koizumi', first: 'Itsuki', last: 'Koizumi' } } },
    { role: 'MAIN', node: { name: { full: 'Kyon', first: 'Kyon' } } },
  ];
  const chars = prioritizeCharacters(edges);
  const hotwords = buildHotwords(chars, 10);
  assert.strictEqual(hotwords, 'Haruhi Suzumiya, Mikuru Asahina, Itsuki Koizumi, Kyon');
});

// ================================================================
// SUITE 4: Fuzzy Character Corrector & English Stoplist Invariants
// ================================================================
console.log('\n--- TEST SUITE 4: Fuzzy Character Corrector ---');

runTest('4.1 Replaces near-miss spelling of character name (Suzumya -> Suzumiya)', () => {
  const names = ['Haruhi Suzumiya', 'Suzumiya', 'Mikuru'];
  const text = 'I spoke with Suzumya earlier today.';
  let loggedOrig = null;
  let loggedRepl = null;
  const corrected = correctCharacterSpellings(text, names, 1, (orig, repl) => {
    loggedOrig = orig;
    loggedRepl = repl;
  });
  assert.strictEqual(corrected, 'I spoke with Suzumiya earlier today.');
  assert.strictEqual(loggedOrig, 'Suzumya');
  assert.strictEqual(loggedRepl, 'Suzumiya');
});

runTest('4.2 MUST NOT replace common English words (May, Light, Ray, Rose, The)', () => {
  const names = ['May', 'Light', 'Ray', 'Rose', 'The'];
  const text = 'You may see a ray of light before the rose blooms.';
  const corrected = correctCharacterSpellings(text, names);
  // None of these common English words should be altered
  assert.strictEqual(corrected, text);
});

runTest('4.3 Case-aware: lower-case words are not treated as character names', () => {
  const names = ['Kajiki', 'Tsuruya'];
  const text = 'we took the kajiki to the market.'; // lowercase
  const corrected = correctCharacterSpellings(text, names);
  assert.strictEqual(corrected, text, 'Lowercase word must not be replaced');
});

runTest('4.4 Does not replace distant words (similarity < 86% or edit distance > 2)', () => {
  const names = ['Suzumiya'];
  const text = 'He was completely Supreme yesterday.'; // "Supreme" vs "Suzumiya" dist 5
  const corrected = correctCharacterSpellings(text, names);
  assert.strictEqual(corrected, text, 'Distant word must not be replaced');
});

// ================================================================
// SUITE 5: Hallucination Filtering on Silence/Music
// ================================================================
console.log('\n--- TEST SUITE 5: Hallucination Filtering ---');

runTest('5.1 Drops standard silence hallucinations (Thank you for watching, Subtitles by)', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:03,000', startMs: 1000, endMs: 3000, text: 'Hello everyone!' },
    { start: '00:00:04,000', end: '00:00:06,000', startMs: 4000, endMs: 6000, text: 'Thank you for watching.' },
    { start: '00:00:07,000', end: '00:00:09,000', startMs: 7000, endMs: 9000, text: 'Subtitles by Amara.org' },
    { start: '00:00:10,000', end: '00:00:12,000', startMs: 10000, endMs: 12000, text: 'We are back.' },
  ];
  const filtered = filterHallucinations(cues);
  assert.strictEqual(filtered.length, 2);
  assert.strictEqual(filtered[0].text, 'Hello everyone!');
  assert.strictEqual(filtered[1].text, 'We are back.');
});

runTest('5.2 Drops repetitive loop hallucinations (e.g. Thank you. Thank you. Thank you.)', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:03,000', startMs: 1000, endMs: 3000, text: 'Thank you. Thank you. Thank you.' },
  ];
  const filtered = filterHallucinations(cues);
  assert.strictEqual(filtered.length, 0, 'Repetitive loop must be dropped');
});

// ================================================================
// SUITE 6: Single-Word Subtitle Merging Invariants
// ================================================================
console.log('\n--- TEST SUITE 6: Single-Word Subtitle Merging ---');

runTest('6.1 NEVER creates a 3rd row: maxLineCount strictly <= 2', () => {
  const cues = [
    {
      start: '00:00:01,000',
      end: '00:00:03,000',
      startMs: 1000,
      endMs: 3000,
      text: 'This is the first long line of dialogue,\nand this is the second long line of dialogue.',
    },
    {
      start: '00:00:03,100',
      end: '00:00:03,500',
      startMs: 3100,
      endMs: 3500,
      text: 'Immediately.',
    },
  ];
  const merged = mergeIsolatedSingleWords(cues, 44, 2);
  // Merging "Immediately." would exceed 2 lines of 44 chars, so it MUST NOT merge into 3 lines!
  for (const c of merged) {
    const lines = c.text.split('\n');
    assert.ok(lines.length <= 2, `Subtitle cue must not have > 2 lines (got ${lines.length}): "${c.text}"`);
  }
});

runTest('6.2 Mid-sentence append: lowercases isolated single word (I think + So. -> I think so.)', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:02,000', startMs: 1000, endMs: 2000, text: 'I think' },
    { start: '00:00:02,150', end: '00:00:02,800', startMs: 2150, endMs: 2800, text: 'So.' },
  ];
  const merged = mergeIsolatedSingleWords(cues, 44, 2);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].text, 'I think so.', 'Single word "So." must be lowercased mid-sentence');
});

runTest('6.3 Start-of-cue prepend: capitalizes orphan word and lowercases next word (because + He -> Because he)', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:01,500', startMs: 1000, endMs: 1500, text: 'because' },
    { start: '00:00:01,700', end: '00:00:03,000', startMs: 1700, endMs: 3000, text: 'He was late.' },
  ];
  const merged = mergeIsolatedSingleWords(cues, 44, 2);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].text, 'Because he was late.', 'Must capitalize start and lowercase continuation');
});

runTest('6.4 Preserves "I" and "I\'m" capitalization when merging', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:01,500', startMs: 1000, endMs: 1500, text: 'Because' },
    { start: '00:00:01,700', end: '00:00:03,000', startMs: 1700, endMs: 3000, text: "I'm ready." },
  ];
  const merged = mergeIsolatedSingleWords(cues, 44, 2);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].text, "Because I'm ready.", 'Must preserve pronoun "I\'m" capitalization');
});

runTest('6.5 Full cleanSubtitleSrt end-to-end integration', () => {
  const rawSrt = `1
00:00:01,000 --> 00:00:02,000
I talked with

2
00:00:02,100 --> 00:00:02,600
Suzumya.

3
00:00:05,000 --> 00:00:08,000
Thank you for watching!

4
00:00:10,000 --> 00:00:12,000
We should go now.
`;

  const cleaned = cleanSubtitleSrt(rawSrt, true, {
    characterNames: ['Haruhi Suzumiya', 'Suzumiya'],
    maxLineWidth: 44,
    maxLineCount: 2,
  });

  // Check that:
  // 1. Single word "Suzumya." merged into "I talked with"
  // 2. Fuzzy spelling corrected "Suzumya" -> "Suzumiya"
  // 3. "Thank you for watching!" hallucination dropped
  // 4. Sequential numbers are 1 and 2
  assert.ok(cleaned.includes('I talked with Suzumiya.'), `Must contain merged & corrected text, got:\n${cleaned}`);
  assert.ok(!cleaned.includes('Thank you for watching'), 'Hallucination must be removed');
  assert.ok(cleaned.startsWith('1\n00:00:01,000 --> 00:00:02,600\nI talked with Suzumiya.'));
});

console.log('\n================================================================');
console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: 0`);
console.log('================================================================\n');
