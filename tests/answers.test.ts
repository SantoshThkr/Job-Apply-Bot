import { describe, expect, it } from 'vitest';
import { answerFor, answerFromFacts, findAnswer, pickOption, type ApplicantFacts } from '../src/jobs/answers.ts';

const answers = [
  { match: ['relocate'], answer: 'Yes' },
  { match: ['ctc'], answer: '12 LPA' },
  { match: ['expected', 'ctc'], answer: '18 LPA' },
  { match: ['notice period'], answer: '30 days' },
  { match: ['node.js', 'years'], answer: '5' },
];

describe('findAnswer', () => {
  it('needs every phrase, as whole words, in the question', () => {
    expect(findAnswer('Are you willing to relocate to Pune?', answers)).toBe('Yes');
    expect(findAnswer('What is your notice period (in days)?', answers)).toBe('30 days');
    expect(findAnswer('How many years of Node.js experience do you have?', answers)).toBe('5');
    expect(findAnswer('Relocation assistance needed?', answers)).toBeNull();
  });

  it('prefers the more specific answer', () => {
    expect(findAnswer('What is your current CTC?', answers)).toBe('12 LPA');
    expect(findAnswer('What is your expected CTC?', answers)).toBe('18 LPA');
  });

  it('refuses to choose between equally specific answers', () => {
    const conflicting = [
      { match: ['willing'], answer: 'Yes' },
      { match: ['relocate'], answer: 'No' },
    ];
    expect(findAnswer('Are you willing to relocate?', conflicting)).toBeNull();
  });

  it('answers nothing when nothing is configured', () => {
    expect(findAnswer('Do you have authorization to work in the US?', [])).toBeNull();
  });
});

describe('pickOption', () => {
  it('matches the same words ignoring case and spacing, never the closest guess', () => {
    expect(pickOption(['Yes', 'No'], 'yes')).toBe('Yes');
    expect(pickOption(['0-15 days', '1 month', '2 months'], '1  Month')).toBe('1 month');
    expect(pickOption(['15 days or less', '1 month'], '30 days')).toBeNull();
    expect(pickOption(['Yes, immediately', 'No'], 'Yes')).toBeNull();
  });
});

describe('answerFromFacts', () => {
  const facts: ApplicantFacts = {
    name: 'Test Candidate',
    experienceYears: 7,
    skills: ['React', 'TypeScript'],
    email: 'candidate@example.com',
    phone: '0000000000',
    currentLocation: 'Pune',
    currentTitle: 'Senior Engineer',
    noticePeriodDays: 30,
  };

  it('fills fields your profile and resume answer', () => {
    expect(answerFromFacts('Full Name *', facts)).toBe('Test Candidate');
    expect(answerFromFacts('Email ID', facts)).toBe('candidate@example.com');
    expect(answerFromFacts('Mobile Number', facts)).toBe('0000000000');
    expect(answerFromFacts('What is your current location?', facts)).toBe('Pune');
    expect(answerFromFacts('Current designation', facts)).toBe('Senior Engineer');
    expect(answerFromFacts('How many years of total experience do you have?', facts)).toBe('7');
    expect(answerFromFacts('Notice period (in days)', facts)).toBe('30');
    expect(answerFromFacts('What is your notice period?', facts)).toBe('30 days');
    expect(answerFromFacts('Key skills', facts)).toBe('React, TypeScript');
  });

  it('picks a choice only when it says exactly the same thing', () => {
    expect(answerFromFacts('What is your notice period?', facts, ['Immediate', '15 Days', '1 Month', '2 Months'])).toBe('1 Month');
    expect(answerFromFacts('What is your notice period?', facts, ['0-15 days', '15-30 days', 'More than 30 days'])).toBeNull();
    expect(answerFromFacts('Total experience', facts, ['5-7 years', '7-10 years'])).toBeNull();
    expect(answerFromFacts('Total experience', facts, ['6 years', '7 years'])).toBe('7 years');
  });

  it('leaves alone questions that only look similar', () => {
    expect(answerFromFacts('How many years of experience do you have in React?', facts)).toBeNull();
    expect(answerFromFacts('Company name', facts)).toBeNull();
    expect(answerFromFacts('Preferred location', facts)).toBeNull();
    expect(answerFromFacts('Contact person', facts)).toBeNull();
    expect(answerFromFacts('What is your current CTC?', facts)).toBeNull();
    expect(answerFromFacts('Expected CTC', facts)).toBeNull();
  });
});

describe('answerFor', () => {
  it('prefers your configured answer, then a known fact, and otherwise gives up', () => {
    const facts: ApplicantFacts = { name: 'Test Candidate', experienceYears: 7, skills: [], noticePeriodDays: 30 };
    const answers = [{ match: ['notice period'], answer: 'Serving notice' }];
    expect(answerFor('What is your notice period?', answers, facts)).toBe('Serving notice');
    expect(answerFor('What is your notice period?', [], facts)).toBe('30 days');
    expect(answerFor('Are you willing to relocate?', [], facts)).toBeNull();
    expect(answerFor('What is your notice period?', [], null)).toBeNull();
  });
});
