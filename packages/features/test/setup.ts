import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import '../src/i18n';
import { missingTranslations } from '@orderloop/ui';
import { writeFileSync } from 'node:fs';
import { afterAll, afterEach } from 'vitest';

afterEach(() => cleanup());

// Finding things after an async render can take longer on a loaded machine than the 1 s default.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no modal <dialog>. Model just what Dialog.web.tsx uses: showModal and close toggle `open`.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// `TEST_LOCALE=bn pnpm test` renders every screen in Bangla; the English left over is the translators' to-do list.
if (process.env.TEST_LOCALE === 'bn' && process.env.MISSING_OUT)
  afterAll(() => {
    const out = process.env.MISSING_OUT!;
    writeFileSync(`${out}.${process.pid}.json`, JSON.stringify(missingTranslations(), null, 1));
  });
