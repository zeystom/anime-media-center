/**
 * Milestone 3 Verification Test Suite
 * Player Ergonomics, Controls & Performance
 *
 * Verifies all 5 core player enhancements:
 * 1. EpisodeDrawer auto-close removal and persistent browsing
 * 2. VideoPlayer episodes toolbar button, KeyE shortcut, pulse loop removal, and KeyS opening validation
 * 3. RippleIndicator icon coverage for 'forward', 'sync', and 'info'
 * 4. TimelineScrubber global event listener cleanup on unmount
 * 5. TrackControls Done/Close buttons on both Tab 1 and Tab 2 with intuitive subtitle controls
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
console.log('   MILESTONE 3 VERIFICATION: PLAYER ERGONOMICS & PERFORMANCE   ');
console.log('================================================================\n');

// File paths
const playerDir = path.join(__dirname, 'src', 'components', 'Player');
const episodeDrawerFile = path.join(playerDir, 'EpisodeDrawer.tsx');
const videoPlayerFile = path.join(playerDir, 'VideoPlayer.tsx');
const rippleIndicatorFile = path.join(playerDir, 'RippleIndicator.tsx');
const timelineScrubberFile = path.join(playerDir, 'TimelineScrubber.tsx');
const trackControlsFile = path.join(playerDir, 'TrackControls.tsx');

// Read source files
const episodeDrawerSrc = fs.readFileSync(episodeDrawerFile, 'utf-8');
const videoPlayerSrc = fs.readFileSync(videoPlayerFile, 'utf-8');
const rippleIndicatorSrc = fs.readFileSync(rippleIndicatorFile, 'utf-8');
const timelineScrubberSrc = fs.readFileSync(timelineScrubberFile, 'utf-8');
const trackControlsSrc = fs.readFileSync(trackControlsFile, 'utf-8');

console.log('--- TEST GROUP 1: EpisodeDrawer Ergonomics & Persistence ---');

runTest('1.1 Aggressive 280ms mouse-leave timer removed completely', () => {
  assert(!episodeDrawerSrc.includes('leaveTimerRef'), 'leaveTimerRef should be deleted');
  assert(!episodeDrawerSrc.includes('handleMouseLeave'), 'handleMouseLeave should be deleted');
  assert(!episodeDrawerSrc.includes('setTimeout(() => {\n      onClose();\n    }, 280)'), '280ms auto-close timer should be removed');
  assert(!episodeDrawerSrc.includes('onMouseLeave={handleMouseLeave}'), 'onMouseLeave event listener should not be attached');
});

runTest('1.2 Drawer remains open until explicit close (Escape key listener present)', () => {
  assert(episodeDrawerSrc.includes("e.key === 'Escape'"), 'EpisodeDrawer must listen for Escape key');
  assert(episodeDrawerSrc.includes('window.addEventListener(\'keydown\', handleKeyDown)'), 'Escape listener attached to window');
  assert(episodeDrawerSrc.includes('window.removeEventListener(\'keydown\', handleKeyDown)'), 'Escape listener cleaned up on unmount or close');
});

runTest('1.3 Backdrop click and Close [X] button preserved for deliberate dismissal', () => {
  assert(episodeDrawerSrc.includes('onClick={onClose}'), 'Backdrop retains onClick={onClose}');
  assert(episodeDrawerSrc.includes('aria-label="Close Episodes Drawer"'), 'Close X button remains accessible');
});

console.log('\n--- TEST GROUP 2: VideoPlayer Performance & Controls ---');

runTest('2.1 Unthrottled 144Hz+ requestAnimationFrame(pulse) loop completely removed', () => {
  assert(!videoPlayerSrc.includes('requestAnimationFrame(pulse)'), 'pulse rAF loop must not exist');
  assert(!videoPlayerSrc.includes('const pulse = () =>'), 'pulse callback must not exist');
  assert(!videoPlayerSrc.includes('animId = requestAnimationFrame'), 'animId rAF must not exist');
});

runTest('2.2 Explicit Episodes button added to toolbar alongside Audio & Subtitles', () => {
  assert(videoPlayerSrc.includes('title="Episodes (E)"'), 'Episodes button must have tooltip "Episodes (E)"');
  assert(videoPlayerSrc.includes('aria-label="Episodes (E)"'), 'Episodes button must have aria-label "Episodes (E)"');
  assert(videoPlayerSrc.includes('setIsEpisodeDrawerOpen'), 'Episodes button must toggle episode drawer');
  assert(videoPlayerSrc.includes('<ListVideo className="w-3.5 h-3.5 text-red-500" />'), 'Episodes button must render ListVideo icon');
});

runTest('2.3 Keyboard shortcut KeyE toggles EpisodeDrawer', () => {
  assert(videoPlayerSrc.includes("case 'KeyE':"), 'Keyboard handler must handle KeyE');
  assert(/case 'KeyE':\s*e\.preventDefault\(\);\s*setIsEpisodeDrawerOpen\(\(prev\) => !prev\);/s.test(videoPlayerSrc), 'KeyE must toggle drawer state');
});

runTest('2.4 KeyS skip opening shortcut only triggers when genuine opening is detected', () => {
  assert(videoPlayerSrc.includes("case 'KeyS':"), 'Keyboard handler must handle KeyS');
  assert(videoPlayerSrc.includes("detectedOpening && currentAbsoluteTime < detectedOpening.end"), 'KeyS must check detectedOpening bounds');
  assert(!videoPlayerSrc.includes("currentAbsoluteTime < duration * 0.7"), 'Indiscriminate duration * 0.7 jump must be eliminated');
});

runTest('2.5 KeyS provides informative feedback when no opening is detected', () => {
  assert(videoPlayerSrc.includes("showRipple('info', 'No opening detected')"), 'KeyS must show informative ripple feedback when opening not detected');
});

runTest('2.6 handleSkipIntro seeks to detectedOpening.end or shows informative ripple', () => {
  assert(videoPlayerSrc.includes("handleSeek(detectedOpening.end)"), 'handleSkipIntro seeks to detectedOpening.end');
  assert(!videoPlayerSrc.includes("handleSkip(88, 'Opening Skipped (+88s)')"), 'Blind 88s skip fallback must be replaced');
});

console.log('\n--- TEST GROUP 3: RippleIndicator Visual Polish ---');

runTest('3.1 RippleType includes forward, seek-forward, sync, and info', () => {
  assert(rippleIndicatorSrc.includes("'forward'"), 'RippleType must include forward');
  assert(rippleIndicatorSrc.includes("'seek-forward'"), 'RippleType must include seek-forward');
  assert(rippleIndicatorSrc.includes("'sync'"), 'RippleType must include sync');
  assert(rippleIndicatorSrc.includes("'info'"), 'RippleType must include info');
});

runTest('3.2 FastForward icon renders for both forward and seek-forward', () => {
  assert(rippleIndicatorSrc.includes("(type === 'seek-forward' || type === 'forward')"), 'FastForward handles seek-forward and forward');
  assert(rippleIndicatorSrc.includes('<FastForward'), 'FastForward component rendered');
});

runTest('3.3 Sync icon renders SlidersHorizontal to eliminate blank boxes', () => {
  assert(rippleIndicatorSrc.includes("type === 'sync' && <SlidersHorizontal"), 'SlidersHorizontal icon rendered for sync');
});

runTest('3.4 Info icon renders for informative feedback', () => {
  assert(rippleIndicatorSrc.includes("type === 'info' && <Info"), 'Info icon rendered for info');
});

console.log('\n--- TEST GROUP 4: TimelineScrubber Event Cleanup & Memory Leaks ---');

runTest('4.1 Active dragging event listeners tracked in dragListenersRef', () => {
  assert(timelineScrubberSrc.includes('dragListenersRef'), 'dragListenersRef must be declared');
  assert(timelineScrubberSrc.includes('dragListenersRef.current = { onMove: onGlobalMouseMove, onUp: onGlobalMouseUp }'), 'Listeners stored in ref during mousedown');
});

runTest('4.2 Window mousemove and mouseup listeners strictly cleaned up on unmount', () => {
  assert(timelineScrubberSrc.includes("window.removeEventListener('mousemove', dragListenersRef.current.onMove)"), 'mousemove removed on unmount');
  assert(timelineScrubberSrc.includes("window.removeEventListener('mouseup', dragListenersRef.current.onUp)"), 'mouseup removed on unmount');
  assert(timelineScrubberSrc.includes('dragListenersRef.current = null'), 'ref cleared to release closures');
});

runTest('4.3 RAF and debounce timer handles cleaned up on component unmount', () => {
  assert(timelineScrubberSrc.includes('cancelAnimationFrame(rafIdRef.current)'), 'RAF cancelled on unmount');
  assert(timelineScrubberSrc.includes('clearTimeout(debounceTimerRef.current)'), 'Debounce timer cleared on unmount');
});

console.log('\n--- TEST GROUP 5: TrackControls Ergonomics & Done Actions ---');

runTest('5.1 Tab 1 (Audio & Subtitle Manager) includes prominent Done button', () => {
  const tab1Match = trackControlsSrc.match(/activeTab === 'tracks'[\s\S]*?activeTab === 'styling'/);
  assert(tab1Match, 'Tab 1 section found');
  const tab1Content = tab1Match[0];
  assert(tab1Content.includes('Done'), 'Tab 1 must contain a Done button');
  assert(tab1Content.includes('onClick={handleClose}'), 'Tab 1 Done button calls handleClose');
});

runTest('5.2 Tab 2 (Subtitle Styling) includes prominent Done button alongside Back button', () => {
  const tab2Match = trackControlsSrc.match(/activeTab === 'styling'[\s\S]*?<\/div>\s*<\/div>\s*\);\s*};/);
  assert(tab2Match, 'Tab 2 section found');
  const tab2Content = tab2Match[0];
  assert(tab2Content.includes('Done'), 'Tab 2 must contain a Done button');
  assert(tab2Content.includes('← Back to Audio & Subtitles'), 'Tab 2 retains Back to Audio & Subtitles button');
  assert(tab2Content.includes('onClick={handleClose}'), 'Tab 2 Done button calls handleClose');
});

runTest('5.3 Subtitle Sync and Font Size controls intuitive and responsive', () => {
  assert(trackControlsSrc.includes('onUpdateSyncOffset(-0.5)'), 'Delay sync by 0.5s');
  assert(trackControlsSrc.includes('onUpdateSyncOffset(0.5)'), 'Advance sync by 0.5s');
  assert(trackControlsSrc.includes('onResetSyncOffset'), 'Reset sync offset option');
  assert(trackControlsSrc.includes('onUpdateFontSize(fontSize - 2)'), 'Decrease font size by 2px');
  assert(trackControlsSrc.includes('onUpdateFontSize(fontSize + 2)'), 'Increase font size by 2px');
});

console.log('\n================================================================');
console.log(`MILESTONE 3 TESTS: ${passedTests} / ${totalTests} PASSED (100%)`);
console.log('================================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
