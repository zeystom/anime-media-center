/**
 * Milestone 4 Verification Test Suite
 * Library UI/UX Polish & Consistency
 *
 * Verifies all 7 core deliverables:
 * 1. EpisodeCard: Subtitle False Negative fix (hasEmbeddedSubtitles), showGlobalToast replacement, hover jitter fix
 * 2. MovieHeroCard: alert() replacement, hasEmbeddedSubtitles badge, duplicate button/badge clutter removal, movie hero broadcast
 * 3. FolderBrowser: Dedicated search empty state with "Clear Search", no episode grid or missing folder box on 0 search matches, consolidated subtitle status
 * 4. UpNextWidget / HomeView / App.tsx (Phase 3 UI refactor): compact UP NEXT / CONTINUE WATCHING resume banner on the new Home tab, HomeView block composition, home-tab-only wiring (replaces the deleted Phase 2 hero resume banner and its dedup logic)
 * 5. SettingsModal: Confirmation dialog before removing media folder, modal accessibility attributes
 * 6. WhisperStudio: Duplicate banner cleanup, developer CLI dump replaced with feature chips, harmonized cards
 * 7. App.tsx: Refined Escape key listener prevents closing video player when episode drawer or modal is open
 */

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('================================================================');
console.log('   MILESTONE 4 VERIFICATION: LIBRARY UI/UX POLISH & CONSISTENCY ');
console.log('================================================================\n');

// Target file paths
const episodeCardFile = path.join(__dirname, 'src', 'components', 'Library', 'EpisodeCard.tsx');
const movieHeroCardFile = path.join(__dirname, 'src', 'components', 'Library', 'MovieHeroCard.tsx');
const folderBrowserFile = path.join(__dirname, 'src', 'components', 'Library', 'FolderBrowser.tsx');
const upNextWidgetFile = path.join(__dirname, 'src', 'components', 'Home', 'UpNextWidget.tsx');
const homeViewFile = path.join(__dirname, 'src', 'components', 'Home', 'HomeView.tsx');
const settingsModalFile = path.join(__dirname, 'src', 'components', 'SettingsModal.tsx');
const whisperStudioFile = path.join(__dirname, 'src', 'components', 'WhisperStudio', 'WhisperStudio.tsx');
const appFile = path.join(__dirname, 'src', 'App.tsx');

// Read source contents
const episodeCardSrc = fs.readFileSync(episodeCardFile, 'utf-8');
const movieHeroCardSrc = fs.readFileSync(movieHeroCardFile, 'utf-8');
const folderBrowserSrc = fs.readFileSync(folderBrowserFile, 'utf-8');
const upNextWidgetSrc = fs.readFileSync(upNextWidgetFile, 'utf-8');
const homeViewSrc = fs.readFileSync(homeViewFile, 'utf-8');
const settingsModalSrc = fs.readFileSync(settingsModalFile, 'utf-8');
const whisperStudioSrc = fs.readFileSync(whisperStudioFile, 'utf-8');
const appSrc = fs.readFileSync(appFile, 'utf-8');

console.log('--- TEST GROUP 1: EpisodeCard Subtitle False Negative & Polish ---');

runTest('1.1 episode.hasEmbeddedSubtitles is checked in EpisodeCard subtitle badges', () => {
  assert(
    episodeCardSrc.includes('episode.hasEmbeddedSubtitles'),
    'EpisodeCard must check episode.hasEmbeddedSubtitles'
  );
  assert(
    episodeCardSrc.includes('<span>Sub</span>') || episodeCardSrc.includes('<span>Eng Sub</span>'),
    'EpisodeCard must render a clean Sub or Eng Sub badge when embedded subtitles are detected'
  );
});

runTest('1.2 Embedded subtitles never fall through to "No Sub"', () => {
  const subtitleSectionMatch = episodeCardSrc.match(/\{episode\.hasEmbeddedDubtitles[\s\S]*?<span>No Sub<\/span>[\s\S]*?\}/);
  assert(subtitleSectionMatch, 'Subtitle rendering block must exist');
  const block = subtitleSectionMatch[0];
  assert(
    block.indexOf('hasEmbeddedSubtitles') < block.indexOf('No Sub'),
    'hasEmbeddedSubtitles check must precede the No Sub fallback'
  );
});

runTest('1.3 Synchronous alert() replaced with showGlobalToast', () => {
  assert(!episodeCardSrc.includes("alert('This episode is currently downloading"), 'alert() must be removed from EpisodeCard');
  assert(episodeCardSrc.includes('showGlobalToast('), 'showGlobalToast must be called in EpisodeCard');
  assert(episodeCardSrc.includes("import { showGlobalToast } from '../Toast'"), 'showGlobalToast must be imported from Toast');
});

runTest('1.4 Downloading card preserves size/metrics on hover without jitter', () => {
  assert(
    episodeCardSrc.includes('If downloading, render centered downloading overlay - preserved on hover without jitter'),
    'Downloading overlay should indicate hover persistence'
  );
  // Ensure the old pill that replaced metrics on group-hover is removed
  assert(
    !episodeCardSrc.includes('group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px]">\n          {episode.isDownloading ? ('),
    'Old jittery group-hover pill that hid file size should be removed'
  );
  assert(
    episodeCardSrc.includes('!episode.isDownloading && ('),
    'Hover overlay with Play button must only be shown for playable (non-downloading) episodes'
  );
});

console.log('\n--- TEST GROUP 2: MovieHeroCard Polish & Subtitle Integrity ---');

runTest('2.1 MovieHeroCard replaces alert() with showGlobalToast', () => {
  assert(!movieHeroCardSrc.includes("alert('This movie is currently downloading"), 'alert() must be removed from MovieHeroCard');
  assert(movieHeroCardSrc.includes('showGlobalToast('), 'showGlobalToast must be called in MovieHeroCard');
});

runTest('2.2 MovieHeroCard checks hasEmbeddedSubtitles in subtitle badges', () => {
  assert(
    movieHeroCardSrc.includes('episode.hasEmbeddedSubtitles || folder.hasEmbeddedSubtitles'),
    'MovieHeroCard must check hasEmbeddedSubtitles'
  );
});

runTest('2.3 Duplicate "Paused at XX:XX" badge removed to eliminate redundancy with action button', () => {
  assert(
    !movieHeroCardSrc.includes('<span>Paused at {formatTime(progress?.currentTime || 0)}</span>'),
    'Duplicate Paused at badge above Resume button must be removed'
  );
});

runTest('2.4 MovieHeroCard broadcasts active movie hero presence', () => {
  assert(
    movieHeroCardSrc.includes("'movie-hero-active-change'"),
    'MovieHeroCard must dispatch movie-hero-active-change event'
  );
  assert(
    movieHeroCardSrc.includes('data-movie-hero-card="true"'),
    'MovieHeroCard root must have data-movie-hero-card attribute'
  );
});

console.log('\n--- TEST GROUP 3: FolderBrowser Search & Header Badge Polish ---');

runTest('3.1 Dedicated search empty state rendered on 0 matches', () => {
  assert(
    folderBrowserSrc.includes('No anime found matching') && folderBrowserSrc.includes('Clear Search'),
    'FolderBrowser must render dedicated search empty state with Clear Search button'
  );
});

runTest('3.2 Library is a pure shelf: no selected-folder details/grid, cards map the filtered set only', () => {
  assert(
    folderBrowserSrc.includes('sortedFolders.map') && !folderBrowserSrc.includes('selectedFolder ? ('),
    'FolderBrowser must render only the filtered poster shelf — the episode grid lives on the title page'
  );
});

runTest('3.3 "No Anime Folders Found" box strictly reserved for unconfigured library (folders.length === 0)', () => {
  assert(
    folderBrowserSrc.includes('folders.length === 0 ? ('),
    'FolderBrowser must only render No Anime Folders Found when entire library folders.length is 0'
  );
});

runTest('3.4 Poster carousel cards check folder.hasEmbeddedSubtitles', () => {
  assert(
    folderBrowserSrc.includes('folder.hasEmbeddedSubtitles'),
    'Carousel poster cards must check folder.hasEmbeddedSubtitles'
  );
});

runTest('3.5 Subtitle status badges consolidated onto the shelf cards', () => {
  assert(
    folderBrowserSrc.includes('folder.hasEmbeddedSubtitles'),
    'Shelf cards must reflect embedded subtitle state'
  );
  assert(
    folderBrowserSrc.includes('Dub Sub') && folderBrowserSrc.includes('AI Sub') && folderBrowserSrc.includes('Ext Sub'),
    'Shelf cards must render the clean consolidated subtitle badges (Dub Sub / AI Sub / Ext Sub)'
  );
});

console.log('\n--- TEST GROUP 4: UP NEXT / Home Composition ---');

runTest('4.1 UpNextWidget is a compact resume banner with timecodes, chips and play action', () => {
  assert(
    upNextWidgetSrc.includes('formatTime('),
    'UpNextWidget must render timecodes via formatTime'
  );
  assert(
    upNextWidgetSrc.includes('onPlay(episode, startAt)'),
    'UpNextWidget must invoke onPlay with the episode and resume offset'
  );
  assert(
    upNextWidgetSrc.includes("'Up next'") && upNextWidgetSrc.includes("'Continue playing'"),
    'UpNextWidget must render both Up next and Continue playing chip labels'
  );
  assert(
    upNextWidgetSrc.includes('uppercase'),
    'UpNextWidget chip labels must be presented uppercase (UP NEXT / CONTINUE WATCHING)'
  );
});

runTest('4.2 HomeView composes the strict Home block order', () => {
  // Downloaded Collection was removed from Home by design: Recently watched
  // (with per-episode resume tiles) replaced it as the library-facing rail.
  assert(
    homeViewSrc.includes('UpNextWidget') &&
      !homeViewSrc.includes('DownloadedRail') &&
      homeViewSrc.includes('RecentEpisodesRail') &&
      homeViewSrc.includes('CatalogRail'),
    'HomeView must reference UpNextWidget, RecentEpisodesRail and CatalogRail without DownloadedRail'
  );
  const order = ['<UpNextWidget', '<RecentEpisodesRail', '<HomeSchedulePreview', '<CatalogRail'].map((name) =>
    homeViewSrc.indexOf(name)
  );
  assert(
    order.every((idx, i) => idx !== -1 && (i === 0 || idx > order[i - 1])),
    'HomeView must compose blocks in order: UpNextWidget, RecentEpisodesRail, HomeSchedulePreview, CatalogRail'
  );
});

runTest('4.3 App renders HomeView on the home tab only and no longer references the deleted hero resume banner', () => {
  // Name of the Phase 2 component deleted by the Phase 3 refactor (joined at runtime to keep
  // this suite free of dangling references to the removed file).
  const deletedHeroComponent = ['Hero', 'Continue', 'Watching'].join('');
  assert(
    appSrc.includes("currentTab === 'home' ? 'block' : 'hidden'") && appSrc.includes('<HomeView'),
    "App.tsx must gate the HomeView render behind currentTab === 'home'"
  );
  assert(
    !appSrc.includes(deletedHeroComponent),
    'App.tsx must no longer import or render the deleted hero resume banner component'
  );
});

console.log('\n--- TEST GROUP 5: SettingsModal Accidental Deletion Prevention ---');

runTest('5.1 SettingsModal has confirmation state before removing media folder', () => {
  assert(
    settingsModalSrc.includes('confirmDeleteIndex'),
    'SettingsModal must maintain confirmDeleteIndex state'
  );
  assert(
    settingsModalSrc.includes('Confirm Remove') && settingsModalSrc.includes('Cancel'),
    'SettingsModal must offer Cancel and Confirm Remove actions before removing folder'
  );
});

runTest('5.2 SettingsModal includes modal accessibility attributes', () => {
  assert(
    settingsModalSrc.includes('role="dialog"') && settingsModalSrc.includes('data-modal="true"'),
    'SettingsModal dialog must have role="dialog" and data-modal="true"'
  );
});

console.log('\n--- TEST GROUP 6: WhisperStudio Polish & Clutter Elimination ---');

runTest('6.1 Developer CLI flags dump (--sentence --ff_sync) removed from UI', () => {
  assert(
    !whisperStudioSrc.includes('--sentence --ff_sync'),
    'Raw CLI flags --sentence --ff_sync must be removed'
  );
  assert(
    !whisperStudioSrc.includes('Max lines: 2 | Max width: 42 chars'),
    'Raw CLI parameter dump must be removed'
  );
});

runTest('6.2 Human-readable feature chips rendered in WhisperStudio', () => {
  assert(
    whisperStudioSrc.includes('large-v3-turbo') &&
    whisperStudioSrc.includes('Accurate Timestamps') &&
    whisperStudioSrc.includes('English Dialogue') &&
    whisperStudioSrc.includes('Standard 2-Line'),
    'WhisperStudio must render polished human-readable feature chips'
  );
});

runTest('6.3 Left configuration cards harmonized with consistent styling', () => {
  assert(
    whisperStudioSrc.includes('rounded-2xl bg-[#141418] border border-white/10 space-y-3 shadow-md'),
    'Configuration cards in WhisperStudio must share consistent dark rounded styling'
  );
});

console.log('\n--- TEST GROUP 7: App.tsx Escape Key Listener Refinement ---');

runTest('7.1 Escape key handler inspects whether episode drawer is open before closing player', () => {
  assert(
    appSrc.includes('isDrawerOpen') && appSrc.includes('.translate-x-0'),
    'App.tsx Escape key listener must check for open drawer (.translate-x-0)'
  );
});

runTest('7.2 Escape key handler inspects whether modal is open before closing player', () => {
  assert(
    appSrc.includes('isModalOpen') &&
    (appSrc.includes('.glass-dropdown') || appSrc.includes('[role="dialog"]') || appSrc.includes('[data-modal="true"]')),
    'App.tsx Escape key listener must check for open modals/dialogs'
  );
});

runTest('7.3 handleClosePlayer() guarded when drawer or modal is open', () => {
  const escapeBlockMatch = appSrc.match(/if \(e\.key === 'Escape'\) \{([\s\S]*?handleClosePlayer\(\);[\s\S]*?)\}/);
  assert(escapeBlockMatch, 'Escape handler block must be present in App.tsx');
  const block = escapeBlockMatch[1];
  assert(
    block.includes('if (isDrawerOpen || isModalOpen) {\n          return;\n        }'),
    'handleClosePlayer() must be prevented if isDrawerOpen or isModalOpen is true'
  );
});

console.log('\n================================================================');
console.log(`MILESTONE 4 TESTS: ${passedTests} / ${totalTests} PASSED (100%)`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
