import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../public/google-apps.js', import.meta.url), 'utf8');

function createDom() {
  return new JSDOM(`<!doctype html><html><head></head><body>
    <button id='workPetBtn' type='button'><span id='workPet'>🤖</span></button>
    <aside id='dataDrawer'></aside><div id='drawerBackdrop'></div>
    <h2 id='dataDrawerTitle'></h2><div id='dataDrawerBody'></div><aside id='sidebar'></aside>
    <button id='gmailBtn'></button><button id='googleCalendarBtn'></button><button id='googleMapsBtn'></button>
  </body></html>`, {
    runScripts: 'outside-only',
    url: 'https://example.test/',
  });
}

test('avatar picker persists the selected avatar and closes with Escape', () => {
  const dom = createDom();
  const { document, Event, KeyboardEvent } = dom.window;
  dom.window.eval(source);
  document.dispatchEvent(new Event('DOMContentLoaded'));

  const trigger = document.getElementById('workPetBtn');
  trigger.click();

  const picker = document.getElementById('workAvatarPicker');
  const fox = picker.querySelector("button[data-work-avatar='🦊']");
  assert.equal(picker.hidden, false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');

  fox.click();
  assert.equal(document.getElementById('workPet').textContent, '🦊');
  assert.equal(dom.window.localStorage.getItem('synchronWorkAvatarV1'), '🦊');
  assert.equal(picker.hidden, true);

  trigger.click();
  assert.equal(picker.querySelector("button[data-work-avatar='🦊']").getAttribute('aria-pressed'), 'true');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(picker.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  dom.window.close();
});
