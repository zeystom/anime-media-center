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
      export { computeRangeDragSelection } from './src/utils/episodeSelection.ts';
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
  restoreMissingSentenceBreaks,
  rebalanceSubtitleCues,
  similarityRatio,
  levenshteinDistance,
  COMMON_ENGLISH_WORDS,
  cleanSubtitleSrt,
  detectOpEdFromChapters,
  filterCuesBySkipRanges,
  isCueInSkipRanges,
  normalizeSingingSuppression,
  buildBalancedAudioFilterChain,
  computeRangeDragSelection,
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

// ================================================================
// SUITE 7: Regression Fixes (Gibberish, Prompt Leaks, Loops, 2-Word Spillover)
// ================================================================
console.log('\n--- TEST SUITE 7: Regression Fixes ---');

runTest('7.1 Drops mixed non-Latin gibberish when isEnglish=true, preserves when isEnglish=false', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:03,000', startMs: 1000, endMs: 3000, text: 'Karininek ihrenkiقar tree in the shower.ossori' },
    { start: '00:00:04,000', end: '00:00:06,000', startMs: 4000, endMs: 6000, text: '않은ka kiddo' },
    { start: '00:00:07,000', end: '00:00:09,000', startMs: 7000, endMs: 9000, text: 'By phoneрыв' },
    { start: '00:00:10,000', end: '00:00:12,000', startMs: 10000, endMs: 12000, text: 'Anyway, we got stuck decorating.' },
  ];

  const filteredEn = filterHallucinations(cues, undefined, { isEnglish: true });
  assert.strictEqual(filteredEn.length, 1, `Expected only clean English cue, got ${filteredEn.length}`);
  assert.strictEqual(filteredEn[0].text, 'Anyway, we got stuck decorating.');

  const filteredNonEn = filterHallucinations(cues, undefined, { isEnglish: false });
  assert.strictEqual(filteredNonEn.length, 4, 'Must preserve non-Latin text when isEnglish=false');
});

runTest('7.2 Strips leaked "Characters from an anime episode" prompt fragments cleanly', () => {
  const standaloneCues = [
    { start: '00:00:01,000', end: '00:00:03,000', startMs: 1000, endMs: 3000, text: 'Characters from an anime episode.' },
    { start: '00:00:07,000', end: '00:00:09,000', startMs: 7000, endMs: 9000, text: 'See you tomorrow.' },
  ];
  const filteredStandalone = filterHallucinations(standaloneCues, undefined, { isEnglish: true });
  assert.strictEqual(filteredStandalone.length, 1);
  assert.strictEqual(filteredStandalone[0].text, 'See you tomorrow.');

  const rawSrt = `1
00:00:01,000 --> 00:00:03,000
Characters from an anime episode.

2
00:00:04,000 --> 00:00:06,000
Characters from an anime episode The Judo Club's better!
`;
  const cleaned = cleanSubtitleSrt(rawSrt, true, { maxLineWidth: 46, maxLineCount: 2 });
  assert.ok(!cleaned.includes('Characters from an anime episode'), `Leaked prompt must be stripped, got:\n${cleaned}`);
  assert.ok(cleaned.includes("The Judo Club's better!"), `Dialogue after leaked prefix must remain, got:\n${cleaned}`);
});

runTest('7.3 Drops repetitive single-word loops (>=5x) while keeping natural 3x repetition', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:05,000', startMs: 1000, endMs: 5000, text: 'hope, hope, hope, hope, hope, hope, hope, hope, hope, hope.' },
    { start: '00:00:06,000', end: '00:00:09,000', startMs: 6000, endMs: 9000, text: "It's cold, cold, cold." },
  ];

  const filtered = filterHallucinations(cues, undefined, { isEnglish: true });
  assert.strictEqual(filtered.length, 1, `Expected loop dropped and 3x natural repetition kept, got ${filtered.length}`);
  assert.strictEqual(filtered[0].text, "It's cold, cold, cold.");
});

runTest('7.4 Merges short 2-word sentence-ending overflow fragment into 2-line cue', () => {
  const cues = [
    { start: '00:00:01,000', end: '00:00:02,800', startMs: 1000, endMs: 2800, text: 'Seriously, you only come around once in' },
    { start: '00:00:02,900', end: '00:00:03,700', startMs: 2900, endMs: 3700, text: 'a while.' },
  ];

  const merged = mergeIsolatedSingleWords(cues, 46, 2, undefined, { maxOrphanLineWidth: 50 });
  assert.strictEqual(merged.length, 1, `Expected 2-word overflow fragment merged, got ${merged.length}`);
  assert.strictEqual(merged[0].endMs, 3700);
  const lines = merged[0].text.split('\n');
  assert.ok(lines.length <= 2, `Merged cue must be <= 2 lines, got ${lines.length}: ${merged[0].text}`);
  for (const line of lines) {
    assert.ok(line.length <= 50, `Each merged line must be <= 50 chars, got ${line.length}: "${line}"`);
  }
  assert.strictEqual(lines.join(' '), 'Seriously, you only come around once in a while.');
});

// ================================================================
// SUITE 8: OP/ED Detection, Skip Ranges & Auto-Prompt Leak Guard
// ================================================================
console.log('\n--- TEST SUITE 8: OP/ED Detection & Skip Filtering ---');

runTest('8.1 Detects named Opening & Ending chapters while preserving Avant and Preview', () => {
  const chapters = [
    { id: 0, start: 0, end: 52.052, title: 'Avant' },
    { id: 1, start: 52.052, end: 141.85, title: 'Opening' },
    { id: 2, start: 141.85, end: 661.828, title: 'A Part' },
    { id: 3, start: 661.828, end: 1329.828, title: 'B Part' },
    { id: 4, start: 1329.828, end: 1419.835, title: 'Ending' },
    { id: 5, start: 1419.835, end: 1451.711, title: 'Preview' },
  ];

  const detected = detectOpEdFromChapters(chapters, 1451.71);
  assert.ok(detected.namedOp, 'Named Opening chapter must be detected');
  assert.strictEqual(detected.namedOp.start, 52.052);
  assert.strictEqual(detected.namedOp.end, 141.85);
  assert.ok(detected.namedEd, 'Named Ending chapter must be detected');
  assert.strictEqual(detected.namedEd.start, 1329.828);
  assert.strictEqual(detected.namedEd.end, 1419.835);
});

runTest('8.2 Detects unnamed ~90s OP and ED chapters in multi-chapter episodes', () => {
  const chapters = [
    { id: 0, start: 0, end: 60, title: 'Chapter 01' },
    { id: 1, start: 60, end: 150, title: 'Chapter 02' },
    { id: 2, start: 150, end: 1320, title: 'Chapter 03' },
    { id: 3, start: 1320, end: 1410, title: 'Chapter 04' },
    { id: 4, start: 1410, end: 1440, title: 'Chapter 05' },
  ];

  const detected = detectOpEdFromChapters(chapters, 1440);
  assert.strictEqual(detected.namedOp, undefined);
  assert.ok(detected.unnamedOp, 'Unnamed 90s OP chapter must be detected');
  assert.strictEqual(detected.unnamedOp.start, 60);
  assert.ok(detected.unnamedEd, 'Unnamed 90s ED chapter must be detected');
  assert.strictEqual(detected.unnamedEd.start, 1320);
});

runTest('8.3 cleanSubtitleSrt drops OP/ED song hallucinations and auto-prompt leaks while keeping edge dialogue', () => {
  const skipRanges = [
    { start: 52.052, end: 141.85, label: 'OP', source: 'chapter' },
    { start: 1329.828, end: 1419.835, label: 'ED', source: 'chapter' },
  ];

  const rawSrt = `1
00:00:45,340 --> 00:00:51,260
I joined a club for the first time!

2
00:01:22,500 --> 00:01:27,540
And again, I've done another characterkeley which makesKS.

3
00:02:03,200 --> 00:02:08,080
This is the third sentence.

4
00:02:25,170 --> 00:02:28,230
These are my fellow Light Music Club members!

5
00:23:10,470 --> 00:23:13,010
Please don't say you are lazy.

6
00:23:40,500 --> 00:23:43,200
See you next episode!
`;

  let filteredCount = 0;
  const cleaned = cleanSubtitleSrt(rawSrt, true, {
    skipRanges,
    onOpEdFiltered: (n) => {
      filteredCount = n;
    },
  });

  assert.strictEqual(filteredCount, 2, 'OP gibberish and ED lyrics inside OP/ED ranges must be filtered');
  assert.ok(cleaned.includes('I joined a club for the first time!'), 'Pre-OP dialogue must remain');
  assert.ok(cleaned.includes('These are my fellow Light Music Club members!'), 'Post-OP dialogue must remain');
  assert.ok(cleaned.includes('See you next episode!'), 'Post-ED preview dialogue must remain');
  assert.ok(!cleaned.includes('characterkeley'), 'OP gibberish must be dropped');
  assert.ok(!cleaned.includes('This is the third sentence'), 'Auto-prompt leak must be dropped');
  assert.ok(!cleaned.includes("Please don't say you are lazy"), 'ED lyrics must be dropped');
});

runTest('8.4 Returns empty string instead of raw hallucinations when all cues are filtered', () => {
  const rawSrt = `1
00:01:22,500 --> 00:01:27,540
And again, I've done another characterkeley.
`;
  const cleaned = cleanSubtitleSrt(rawSrt, true, {
    skipRanges: [{ start: 52, end: 142, label: 'OP', source: 'chapter' }],
  });
  assert.strictEqual(cleaned, '', 'Fully filtered SRT must not revert to raw unfiltered hallucinations');
  assert.strictEqual(isCueInSkipRanges(52100, 52900, [{ start: 52, end: 142, label: 'OP', source: 'chapter' }]), false, '1.5s boundary margin protects pre/post-OP edge speech');
});

// ================================================================
// SUITE 9: Syntactic Cue Rebalancing & Missing Sentence Restoration
// ================================================================
console.log('\n--- TEST SUITE 9: Syntactic Cue Rebalancing & Sentence Breaks ---');

runTest('9.1 Rebalances K-ON Ep 4 unpunctuated chain without dangling "We\'ll be" or "Yeah,"', () => {
  const rawSrt = `1
00:02:44,000 --> 00:02:46,500
We're having a training camp Training camp?

2
00:02:47,000 --> 00:02:51,500
We're not going out there to play around This
will be a band training camp We'll be

3
00:02:51,500 --> 00:02:55,800
practicing non-stop from sunup to sundown I
better buy new clothes to wear Yeah,

4
00:02:55,800 --> 00:02:58,200
I need to buy a swimsuit too Listen!

5
00:03:20,000 --> 00:03:23,500
How about a maid cafe A
haunted house sounds fun too.
`;

  const cleaned = cleanSubtitleSrt(rawSrt, true, {
    maxLineWidth: 46,
    maxLineCount: 2,
  });

  const blocks = cleaned.trim().split(/\n\s*\n/).map((b) => b.split('\n').slice(2).join('\n'));
  for (const text of blocks) {
    const lines = text.split('\n');
    assert.ok(lines.length <= 2, `Cue exceeds 2 lines:\n${text}`);
    for (const line of lines) {
      assert.ok(line.length <= 48, `Line too long (${line.length}): "${line}"`);
    }
    assert.ok(!/\bWe'll be$/m.test(lines[lines.length - 1]), `Cue must not end with dangling "We'll be":\n${text}`);
    assert.ok(!/\bYeah,$/m.test(lines[lines.length - 1]), `Cue must not end with dangling "Yeah,":\n${text}`);
    assert.ok(!/\b(?:I|This|A)$/.test(lines[lines.length - 1]), `Cue must not end with dangling word:\n${text}`);
  }

  assert.ok(cleaned.includes("We're having a training camp."), `Expected restored period in:\n${cleaned}`);
  assert.ok(cleaned.includes("Training camp?"), `Expected intact question in:\n${cleaned}`);
  assert.ok(cleaned.includes("We'll be practicing"), `Expected "We'll be" kept with "practicing":\n${cleaned}`);
  assert.ok(cleaned.includes("Yeah, I need to buy a swimsuit too."), `Expected "Yeah," kept with "I need to buy...":\n${cleaned}`);
  assert.ok(cleaned.includes("maid cafe."), `Expected restored period before "A haunted house":\n${cleaned}`);
});

runTest('9.2 Splits Ep 5 club/festival chains at syntactic boundaries without stranding use/as/at', () => {
  const rawSrt = `1
00:05:10,000 --> 00:05:13,500
If only the band could use

2
00:05:13,500 --> 00:05:17,000
the stage if nobody stops us.

3
00:05:18,000 --> 00:05:21,500
Because we aren't recognized as

4
00:05:21,500 --> 00:05:25,000
a legitimate club yet, we cannot play.

5
00:05:26,000 --> 00:05:29,500
No live performances at

6
00:05:29,500 --> 00:05:33,000
the Sakura High Festival this fall.
`;

  const cleaned = cleanSubtitleSrt(rawSrt, true, {
    maxLineWidth: 46,
    maxLineCount: 2,
  });

  const blocks = cleaned.trim().split(/\n\s*\n/).map((b) => b.split('\n').slice(2).join('\n'));
  for (const text of blocks) {
    const lines = text.split('\n');
    assert.ok(lines.length <= 2, `Cue exceeds 2 lines:\n${text}`);
    const lastWord = text.replace(/\n/g, ' ').trim();
    assert.ok(!/\bcould use$/.test(lastWord), `Cue must not end with "could use":\n${text}`);
    assert.ok(!/\brecognized as$/.test(lastWord), `Cue must not end with "recognized as":\n${text}`);
    assert.ok(!/\bperformances at$/.test(lastWord), `Cue must not end with "performances at":\n${text}`);
  }

  assert.ok(cleaned.includes('could use the stage'), `Expected "could use the stage" intact:\n${cleaned}`);
  assert.ok(
    cleaned.includes('recognized as a legitimate club') ||
      cleaned.includes('recognized as\na legitimate club') ||
      cleaned.includes('recognized\nas a legitimate club'),
    `Expected "recognized as a legitimate club" together in one cue:\n${cleaned}`
  );
  assert.ok(
    cleaned.includes('performances at the Sakura High Festival') ||
      cleaned.includes('performances\nat the Sakura High Festival') ||
      cleaned.includes('performances at\nthe Sakura High Festival') ||
      cleaned.includes('Sakura High Festival'),
    `Expected "Sakura High Festival" kept intact without splitting mid-name:\n${cleaned}`
  );
});

runTest('9.3 Prevents "you will / be." and "you will / be alright." illogical splits', () => {
  const shortSplit = `1
00:01:00,000 --> 00:01:02,000
Wait just a second and you will

2
00:01:02,000 --> 00:01:03,000
be.
`;
  const cleanedShort = cleanSubtitleSrt(shortSplit, true, { maxLineWidth: 46, maxLineCount: 2 });
  assert.ok(!/\byou will\n/.test(cleanedShort) && cleanedShort.includes('you will be.'), `Short "you will / be." must stay together:\n${cleanedShort}`);

  const longSplit = `1
00:01:05,000 --> 00:01:08,000
Just keep practicing every single day and you will

2
00:01:08,000 --> 00:01:10,500
be alright in the end, I promise.
`;
  const cleanedLong = cleanSubtitleSrt(longSplit, true, { maxLineWidth: 46, maxLineCount: 2 });
  const cuesLong = cleanedLong.trim().split(/\n\s*\n/).map((b) => b.split('\n').slice(2).join('\n'));
  for (const text of cuesLong) {
    assert.ok(!/\byou will$/.test(text.replace(/\n/g, ' ').trim()), `Cue must not end with "you will":\n${text}`);
  }
  assert.ok(
    cleanedLong.includes('you will be alright') || cleanedLong.includes('you will\nbe alright'),
    `Expected "you will be alright" kept together across cue boundary:\n${cleanedLong}`
  );
});

runTest('9.4 Negative guards: protects proper nouns, "I", and collapses 1-line wraps', () => {
  assert.strictEqual(
    restoreMissingSentenceBreaks('We joined the Light Music Club'),
    'We joined the Light Music Club',
    'Must not insert period inside capitalized club name'
  );
  assert.strictEqual(
    restoreMissingSentenceBreaks('at the Sakura High Festival'),
    'at the Sakura High Festival',
    'Must not insert period inside capitalized festival name'
  );
  assert.strictEqual(
    restoreMissingSentenceBreaks('I think This is fine'),
    'I think This is fine',
    'Must keep conservative guard or avoid spurious mid-clause split on proper/emphatic tokens if unprotected'
  );
  assert.strictEqual(
    restoreMissingSentenceBreaks('She told me I should practice'),
    'She told me I should practice',
    'Must not split before pronoun "I" after "me"'
  );
  assert.strictEqual(
    restoreMissingSentenceBreaks('the day I met Suzumiya'),
    'the day I met Suzumiya',
    'Must not split inside "the day I met Suzumiya"'
  );

  const collapsed = balanceSubtitleLines('My grandma used to compliment me all\nthe time.', 46);
  assert.strictEqual(collapsed.lines.length, 1, `Short 44-char cue must stay on 1 line, got: ${JSON.stringify(collapsed.lines)}`);
  assert.strictEqual(collapsed.lines[0], 'My grandma used to compliment me all the time.');
});

runTest('9.5 Normalizes tri-state singing filter modes and builds soft-blend FFmpeg filtergraph', () => {
  assert.strictEqual(normalizeSingingSuppression(undefined), 'off');
  assert.strictEqual(normalizeSingingSuppression(false), 'off');
  assert.strictEqual(normalizeSingingSuppression('off'), 'off');
  assert.strictEqual(normalizeSingingSuppression('balanced'), 'balanced');
  assert.strictEqual(normalizeSingingSuppression('strict'), 'strict');
  assert.strictEqual(normalizeSingingSuppression(true), 'strict', 'Legacy boolean true preserves strict mode');

  const balancedStereo = buildBalancedAudioFilterChain({
    rnndnModelName: 'sh.rnnn',
    rnndnMix: 0.6,
    extractFrontCenter: false,
  });
  assert.deepStrictEqual(balancedStereo, [
    'aresample=48000:async=3600:first_pts=0',
    'arnndn=m=sh.rnnn:mix=0.6',
  ]);

  const balancedSurround = buildBalancedAudioFilterChain({
    rnndnModelName: 'sh.rnnn',
    rnndnMix: 0.6,
    extractFrontCenter: true,
  });
  assert.deepStrictEqual(balancedSurround, [
    'pan=mono|c0=FC',
    'aresample=48000:async=3600:first_pts=0',
    'arnndn=m=sh.rnnn:mix=0.6',
  ]);
});

runTest('9.6 Phone-gallery range selection selects/deselects contiguous episodes across rows and restores on pullback', () => {
  const ordered = Array.from({ length: 13 }, (_, idx) => `ep${idx + 1}.mkv`);
  const base = new Set(['ep1.mkv', 'ep12.mkv']);

  // Forward drag across rows: ep3 (idx 2) -> ep10 (idx 9)
  const forward = computeRangeDragSelection({
    orderedPaths: ordered,
    baseSelection: base,
    anchorIndex: 2,
    targetIndex: 9,
    select: true,
  });
  assert.strictEqual(forward.has('ep1.mkv'), true, 'Pre-selected ep1 must remain selected');
  assert.strictEqual(forward.has('ep12.mkv'), true, 'Pre-selected ep12 must remain selected');
  assert.strictEqual(forward.has('ep2.mkv'), false);
  assert.strictEqual(forward.has('ep11.mkv'), false);
  for (let i = 2; i <= 9; i++) {
    assert.strictEqual(forward.has(ordered[i]), true, `Expected ${ordered[i]} inside [3..10] to be selected`);
  }

  // Pull back while still dragging: ep3 (idx 2) -> ep6 (idx 5)
  const pulledBack = computeRangeDragSelection({
    orderedPaths: ordered,
    baseSelection: base,
    anchorIndex: 2,
    targetIndex: 5,
    select: true,
  });
  for (let i = 2; i <= 5; i++) {
    assert.strictEqual(pulledBack.has(ordered[i]), true);
  }
  for (let i = 6; i <= 9; i++) {
    assert.strictEqual(pulledBack.has(ordered[i]), false, `Expected ${ordered[i]} to revert cleanly on pullback`);
  }

  // Reverse drag bottom-to-top: ep10 -> ep3
  const reverse = computeRangeDragSelection({
    orderedPaths: ordered,
    baseSelection: new Set(),
    anchorIndex: 9,
    targetIndex: 2,
    select: true,
  });
  assert.strictEqual(reverse.size, 8);

  // Deselect drag: ep3 -> ep5 from full selection
  const full = new Set(ordered);
  const deselected = computeRangeDragSelection({
    orderedPaths: ordered,
    baseSelection: full,
    anchorIndex: 2,
    targetIndex: 4,
    select: false,
  });
  assert.strictEqual(deselected.has('ep2.mkv'), true);
  assert.strictEqual(deselected.has('ep3.mkv'), false);
  assert.strictEqual(deselected.has('ep4.mkv'), false);
  assert.strictEqual(deselected.has('ep5.mkv'), false);
  assert.strictEqual(deselected.has('ep6.mkv'), true);
});

console.log('\n================================================================');
console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: 0`);
console.log('================================================================\n');
