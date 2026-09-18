import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSchoolSources } from '../src/discovery.mjs';

const football = { slug: 'football', name: 'Football', code: 'MFB', gender: 'men' };
const baseball = { slug: 'baseball', name: 'Baseball', code: 'MBA', gender: 'men' };
const school = { athleticsUrl: 'https://sports.example.edu/', sports: [football, baseball] };

test('legacy football home preserves observed modern football collection links', () => {
  const html = '<a href="/index.aspx?path=fb">Football</a>'
    + '<a href="/sports/football/schedule">Football: Schedule</a>'
    + '<a href="/sports/football/roster">Football: Roster</a>'
    + '<a href="/sports/football/archives">Football: News</a>';
  const source = discoverSchoolSources(html, school).sports.football;
  assert.equal(source.homeUrl, 'https://sports.example.edu/index.aspx?path=fb');
  assert.equal(source.newsUrl, 'https://sports.example.edu/sports/football/archives');
  assert.equal(source.rosterUrl, 'https://sports.example.edu/sports/football/roster');
  assert.equal(source.scheduleUrl, 'https://sports.example.edu/sports/football/schedule');
});

test('a legacy football home does not adopt another sport, article, or external archive', () => {
  const html = '<a href="/index.aspx?path=fb">Football</a>'
    + '<a href="/sports/baseball/archives">Football: News</a>'
    + '<a href="/news/2026/9/17/football-weekly-notes.aspx">Football: News</a>'
    + '<a href="https://other.example/sports/football/archives">Football: News</a>';
  const source = discoverSchoolSources(html, school).sports.football;
  assert.equal(source.newsUrl, 'https://sports.example.edu/index.aspx?path=fb');
  assert.equal(source.rosterUrl, null);
  assert.equal(source.scheduleUrl, null);
});

test('modern collection links cannot override an explicit opposite-gender route', () => {
  const men = { slug: 'basketball', name: "Men's Basketball", code: 'MBB', gender: 'men' };
  const women = { slug: 'womens-basketball', name: "Women's Basketball", code: 'WBB', gender: 'women' };
  const html = '<a href="/index.aspx?path=mbball">Men\'s Basketball</a>'
    + '<a href="/sports/womens-basketball/archives">Men\'s Basketball: News</a>';
  const source = discoverSchoolSources(html, { ...school, sports: [men, women] }).sports.basketball;
  assert.equal(source.newsUrl, 'https://sports.example.edu/index.aspx?path=mbball');
});
