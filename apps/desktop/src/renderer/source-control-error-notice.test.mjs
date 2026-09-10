import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describeError } from "./ErrorNotice.tsx";
import {
  describeSourceControlError,
  sourceControlErrorToastText,
  SourceControlErrorNotice,
} from "./SourceControlErrorNotice.tsx";

const rejectedPush = new Error([
  "Error invoking remote method 'mixdog:git-push': Error: To https://github.com/tribgames/mixdog.git",
  "! [rejected] main -> main (fetch first)",
  "error: failed to push some refs to 'https://github.com/tribgames/mixdog.git'",
  "hint: Updates were rejected because the remote contains work that you do not have locally.",
].join("\n"));

test("a behind-remote push renders concise guidance with collapsed Git details", () => {
  const presentation = describeSourceControlError(rejectedPush);
  assert.equal(presentation.kind, "non-fast-forward");
  assert.match(presentation.details, /^To https:\/\/github\.com\/tribgames\/mixdog\.git/);
  assert.doesNotMatch(presentation.details, /Error invoking remote method/);

  const markup = renderToStaticMarkup(createElement(SourceControlErrorNotice, {
    error: rejectedPush,
  }));
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Push blocked/);
  assert.match(markup, /remote branch has newer commits/i);
  assert.match(markup, /<details/);
  assert.match(markup, /Show details/);
  assert.doesNotMatch(markup, /Error invoking remote method/);
});

test("short ordinary failures stay compact without redundant details", () => {
  const markup = renderToStaticMarkup(createElement(SourceControlErrorNotice, {
    error: new Error("Nothing to commit."),
  }));
  assert.match(markup, /Git action failed/);
  assert.match(markup, /Nothing to commit\./);
  assert.doesNotMatch(markup, /<details/);
});

test("authentication failures expose sign-in help without dumping transport noise", () => {
  const markup = renderToStaticMarkup(createElement(SourceControlErrorNotice, {
    error: "Error: fatal: Authentication failed for 'https://github.com/tribgames/mixdog.git'",
    onAuthenticationHelp: () => {},
    authenticationHelpLabel: "GitHub CLI help",
  }));
  assert.match(markup, /Sign-in required/);
  assert.match(markup, /GitHub CLI help/);
  assert.doesNotMatch(markup, />Error:/);
});

test("a failed push toasts as one classified line with the Git output behind it", () => {
  const text = sourceControlErrorToastText(rejectedPush);
  const [headline] = text.split("\n");
  assert.match(headline, /^Push blocked — /);
  // The toast renders the FIRST line as its summary; the raw Git output must
  // stay off it and ride behind the notice's own disclosure.
  assert.equal(describeError(text).summary, headline);
  assert.match(text, /\n\nTo https:\/\/github\.com\/tribgames\/mixdog\.git/);
  assert.doesNotMatch(headline, /rejected|hint:/);
});

test("an ordinary failure toasts as its classified line and carries no empty body", () => {
  const text = sourceControlErrorToastText(new Error("Nothing to commit."));
  assert.equal(text, "Git action failed — Nothing to commit.");
  assert.equal(describeError(text).summary, text);
});
