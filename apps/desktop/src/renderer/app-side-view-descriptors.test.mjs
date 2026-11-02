import assert from 'node:assert/strict';
import test from 'node:test';
import { Image } from 'lucide-react';
import { createAppSideViewDescriptors } from './app-side-view-descriptors.ts';

test('Studio is an action rail entry: activating it opens Studio, no panel', () => {
  let opened = 0;
  const studio = createAppSideViewDescriptors(
    () => {},
    () => {
      opened += 1;
    }
  ).get('studio');
  assert.equal(studio.label, 'Studio');
  const skills = createAppSideViewDescriptors(
    () => {},
    () => {}
  ).get('skills');
  assert.notEqual(studio.icon, skills.icon, 'Studio does not share Skills’ icon');
  assert.equal(studio.icon, Image, 'Studio uses lucide Image');
  studio.onActivate();
  assert.equal(opened, 1);
});
