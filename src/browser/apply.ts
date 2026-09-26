import type { Locator, Page, Response } from 'playwright';
import { z } from 'zod';
import { APPLY_SELECTORS, JOB_API } from './selectors.ts';
import { assertUsable, detectChallenge } from './session.ts';

export type JobPageState =
  | { kind: 'CAN_APPLY' }
  | { kind: 'ALREADY_APPLIED' }
  | { kind: 'EXTERNAL'; externalUrl: string | null }
  | { kind: 'UNAVAILABLE'; reason: string }
  | { kind: 'NO_BUTTON' };

const jobApiSchema = z.object({ jobDetails: z.object({ applyRedirectUrl: z.string().optional() }) });

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).count().then((n) => n > 0);

async function goto(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    // After a failed load Chrome commits its error page late, which interrupts the next navigation,
    // though Chrome usually still completes it afterwards.
    if (!/interrupted by another navigation/.test(String(err))) throw err;
    await page
      .waitForURL(url, { waitUntil: 'domcontentloaded', timeout: 5_000 })
      .catch(() => page.goto(url, { waitUntil: 'domcontentloaded' }));
  }
}

// Opens a job and reports which apply control Naukri shows. Clicks nothing.
export async function openJobPage(page: Page, url: string, { waitMs = 15_000 } = {}): Promise<JobPageState> {
  let api: Promise<unknown> = Promise.resolve(null);
  const onResponse = (res: Response) => {
    if (JOB_API.test(res.url())) api = res.json().catch(() => null);
  };
  page.on('response', onResponse);
  try {
    await goto(page, url);
    await assertUsable(page);
    return await readApplyControls(page, waitMs, () => api);
  } finally {
    page.off('response', onResponse);
  }
}

async function readApplyControls(page: Page, waitMs: number, api: () => Promise<unknown>): Promise<JobPageState> {
  const { appliedMarker, applyButton, companySiteButton, unavailableText } = APPLY_SELECTORS;
  await page
    .locator([appliedMarker, applyButton, companySiteButton].join(', '))
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: waitMs })
    .catch(() => {});

  if (await visible(page, appliedMarker)) return { kind: 'ALREADY_APPLIED' };
  if (await visible(page, companySiteButton)) {
    const details = jobApiSchema.safeParse(await api());
    return { kind: 'EXTERNAL', externalUrl: (details.success && details.data.jobDetails.applyRedirectUrl) || null };
  }
  if (await visible(page, applyButton)) return { kind: 'CAN_APPLY' };

  await assertUsable(page);
  const text = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  const unavailable = text.match(unavailableText);
  return unavailable ? { kind: 'UNAVAILABLE', reason: `Naukri says: "${unavailable[0]}"` } : { kind: 'NO_BUTTON' };
}

// Evidence that Naukri accepted an application, in its own words, or null.
export async function successEvidence(page: Page): Promise<string | null> {
  if (new URL(page.url()).pathname.startsWith(APPLY_SELECTORS.successPath)) return 'Naukri opened its application confirmation page';
  const text = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
  const match = text.match(APPLY_SELECTORS.successText);
  return match ? `Naukri showed "${match[0]}"` : null;
}

// Naukri's own words for an application that did not go through, or null.
export async function errorEvidence(page: Page): Promise<string | null> {
  const text = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
  const match = text.match(APPLY_SELECTORS.errorText);
  return match ? `Naukri showed "${match[0]}"` : null;
}

export type ApplyClickResult =
  | { kind: 'CONFIRMED'; evidence: string }
  | { kind: 'QUESTIONNAIRE' }
  | { kind: 'FORM' }
  | { kind: 'EXTERNAL'; url: string }
  | { kind: 'ERROR'; evidence: string }
  | { kind: 'NO_RESPONSE' };

const questionnaire = (page: Page) => page.locator(APPLY_SELECTORS.questionnaire).filter({ visible: true }).first();
const applyForm = (page: Page) => page.locator(APPLY_SELECTORS.applyForm).filter({ visible: true }).last();

// Clicks Apply once and watches what Naukri does next. On Naukri this click can itself send the
// application, so callers only get here with auto apply on.
export async function clickApply(page: Page, { waitMs = 20_000 } = {}): Promise<ApplyClickResult> {
  let opened: Page | undefined;
  const onPage = (tab: Page) => {
    opened = tab;
  };
  page.context().on('page', onPage);
  try {
    const formsBefore = await page.locator(APPLY_SELECTORS.applyForm).filter({ visible: true }).count();
    await page.locator(APPLY_SELECTORS.applyButton).filter({ visible: true }).first().click();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await detectChallenge(page)) await assertUsable(page);
      const evidence = await successEvidence(page);
      if (evidence) return { kind: 'CONFIRMED', evidence };
      if (await questionnaire(page).count()) return { kind: 'QUESTIONNAIRE' };
      if ((await page.locator(APPLY_SELECTORS.applyForm).filter({ visible: true }).count()) > formsBefore) return { kind: 'FORM' };
      const error = await errorEvidence(page);
      if (error) return { kind: 'ERROR', evidence: error };
      if (opened) {
        await opened.waitForLoadState('domcontentloaded').catch(() => {});
        const url = opened.url();
        // The bot never continues on another company's site.
        await opened.close().catch(() => {});
        return { kind: 'EXTERNAL', url };
      }
      await page.waitForTimeout(500);
    }
    return { kind: 'NO_RESPONSE' };
  } finally {
    page.context().off('page', onPage);
  }
}

export interface Question {
  text: string;
  kind: 'text' | 'single' | 'multi' | 'file' | 'unsupported';
  options: string[];
}

export type Reply = { text: string } | { options: string[] } | { file: string };

function optionsIn(drawer: Locator, kind: 'single' | 'multi'): Locator {
  const { radioOption, chipOption, checkboxOption } = APPLY_SELECTORS;
  return drawer.locator(kind === 'single' ? `${radioOption}, ${chipOption}` : checkboxOption).filter({ visible: true });
}

async function describeControls(drawer: Locator): Promise<Omit<Question, 'text'> | null> {
  const { fileInput, unsupportedInput, textInput } = APPLY_SELECTORS;
  const texts = async (options: Locator) => (await options.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  if (await drawer.locator(fileInput).count()) return { kind: 'file', options: [] };
  if (await drawer.locator(unsupportedInput).filter({ visible: true }).count()) return { kind: 'unsupported', options: [] };
  for (const kind of ['single', 'multi'] as const) {
    const options = await texts(optionsIn(drawer, kind));
    if (options.length) return { kind, options };
  }
  if (await drawer.locator(textInput).filter({ visible: true }).count()) return { kind: 'text', options: [] };
  return null;
}

export type QuestionStep = { question: Question; messages: number } | 'DONE' | 'TIMEOUT';

// Waits for the next recruiter question (a bot message beyond `seen`, with its controls rendered), or
// 'DONE' once the drawer closes or Naukri confirms, which happens after the last answer.
export async function readQuestion(page: Page, seen: number, { waitMs = 15_000 } = {}): Promise<QuestionStep> {
  const deadline = Date.now() + waitMs;
  let previous = -1;
  while (Date.now() < deadline) {
    const drawer = questionnaire(page);
    if (!(await drawer.count()) || (await successEvidence(page))) return 'DONE';
    const messages = drawer.locator(APPLY_SELECTORS.botMessage);
    const count = await messages.count();
    // Naukri may post a greeting before the question; read only once the messages stop arriving.
    const settled = count === previous;
    previous = count;
    if (count > seen && settled) {
      const controls = await describeControls(drawer);
      const text = (await messages.last().innerText().catch(() => '')).trim();
      if (controls && text) return { question: { text, ...controls }, messages: count };
    }
    await page.waitForTimeout(400);
  }
  return 'TIMEOUT';
}

export async function answerQuestion(page: Page, question: Question, reply: Reply): Promise<void> {
  const drawer = questionnaire(page);
  if ('file' in reply) {
    await drawer.locator(APPLY_SELECTORS.fileInput).first().setInputFiles(reply.file);
  } else if ('text' in reply) {
    const input = drawer.locator(APPLY_SELECTORS.textInput).filter({ visible: true }).last();
    await input.click();
    await input.fill(reply.text);
  } else {
    const options = optionsIn(drawer, question.kind === 'multi' ? 'multi' : 'single');
    for (const choice of reply.options) {
      const option = options.nth(question.options.indexOf(choice));
      const label = option.locator('label').first();
      await ((await label.count()) ? label : option).click();
      // A click that missed must not turn into an empty answer.
      const input = option.locator('input').first();
      if ((await input.count()) && !(await input.isChecked())) await input.check({ force: true });
    }
  }
  // Chip answers can send themselves; everything else needs Save.
  const save = drawer.locator(APPLY_SELECTORS.saveButton).filter({ visible: true }).last();
  if (await save.count()) await save.click();
}

export interface FormField {
  // Where the field is among the form's fields; a radio group points at its first radio.
  index: number;
  label: string;
  kind: 'text' | 'number' | 'select' | 'radio' | 'checkbox' | 'file' | 'unsupported';
  required: boolean;
  options: string[];
  // Naukri may prefill fields from your profile; those are left as they are.
  filled: boolean;
}

// The fields of the application form that Apply opened, each named by its label, aria-label,
// placeholder or name, in that order of preference.
export async function readForm(page: Page): Promise<FormField[]> {
  const fields = await applyForm(page)
    .locator(APPLY_SELECTORS.formField)
    .evaluateAll((elements) => {
      const labelOf = (el: Element) => {
        const input = el as HTMLInputElement;
        const byId = el.getAttribute('aria-labelledby')?.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        const legend = input.type === 'radio' ? el.closest('fieldset')?.querySelector('legend')?.textContent : undefined;
        return (legend || input.labels?.[0]?.textContent || el.getAttribute('aria-label') || byId || el.getAttribute('placeholder') || el.getAttribute('name') || '')
          .replace(/\s+/g, ' ')
          .trim();
      };
      return elements.map((el, index) => {
        const input = el as HTMLInputElement;
        const tag = el.tagName.toLowerCase();
        const type = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : input.type;
        return {
          index,
          name: input.name,
          type,
          label: labelOf(el),
          optionLabel: (input.labels?.[0]?.textContent ?? '').trim(),
          required: input.required || el.getAttribute('aria-required') === 'true' || /\*/.test(labelOf(el)),
          options: tag === 'select' ? Array.from((el as HTMLSelectElement).options).filter((o) => o.value).map((o) => o.text.trim()) : [],
          filled: type === 'checkbox' || type === 'radio' ? input.checked : Boolean(input.value),
        };
      });
    });

  const result: FormField[] = [];
  for (const field of fields) {
    if (field.type === 'radio') {
      const group = result.find((f) => f.kind === 'radio' && fields[f.index]?.name === field.name);
      if (group) {
        group.options.push(field.optionLabel);
        group.filled ||= field.filled;
        continue;
      }
    }
    const kind =
      field.type === 'select' || field.type === 'radio' || field.type === 'checkbox' || field.type === 'file'
        ? field.type
        : field.type === 'number'
          ? 'number'
          : ['text', 'email', 'tel', 'url', 'textarea', 'search'].includes(field.type)
            ? 'text'
            : 'unsupported';
    result.push({
      index: field.index,
      label: field.type === 'radio' && field.label === field.optionLabel ? field.name : field.label,
      kind,
      required: field.required,
      options: field.type === 'radio' ? [field.optionLabel] : field.options,
      filled: field.filled,
    });
  }
  return result;
}

export async function fillField(page: Page, field: FormField, value: string): Promise<void> {
  const fields = applyForm(page).locator(APPLY_SELECTORS.formField);
  const control = fields.nth(field.index);
  switch (field.kind) {
    case 'select':
      await control.selectOption({ label: value });
      return;
    case 'radio': {
      const name = await control.getAttribute('name');
      const count = await fields.count();
      for (let i = 0; i < count; i++) {
        const radio = fields.nth(i);
        const isOption = await radio.evaluate(
          (el, [group, label]) => {
            const input = el as HTMLInputElement;
            return input.type === 'radio' && input.name === group && (input.labels?.[0]?.textContent ?? '').trim() === label;
          },
          [name, value] as const,
        );
        if (isOption) return radio.check({ force: true });
      }
      throw new Error(`No option "${value}" in "${field.label}"`);
    }
    case 'checkbox':
      await control.setChecked(/^(yes|true|agree|i agree)$/i.test(value), { force: true });
      return;
    case 'file':
      await control.setInputFiles(value);
      return;
    default:
      await control.fill(value);
  }
}

// Clicks the form's own submit button. False when there isn't one to click.
export async function submitForm(page: Page): Promise<boolean> {
  const submit = applyForm(page).locator(APPLY_SELECTORS.formSubmit).filter({ visible: true }).first();
  if (!(await submit.count())) return false;
  await submit.click();
  return true;
}
