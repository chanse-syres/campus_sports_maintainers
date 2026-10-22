import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool } from '../src/config.mjs';
import { parseOfficialNews } from '../src/adapters/official.mjs';

const school = await getSchool('north-carolina-central-university');
const payload = `<script>var obj = ${JSON.stringify({type:'stories',data:[
  {story_headline:'Eagles to Open MEAC Play at Delaware State',story_path:'/news/2026/10/21/football-eagles-to-open-meac-play.aspx',story_postdate:'2026-10-21T00:00:00Z',sport_title:'Football',sports_cats:'Football,Flag Football'},
  {story_headline:'King Named Inaugural Flag Football Head Coach',story_path:'/news/2026/8/20/flag-football-king-named-head-coach.aspx',story_postdate:'2026-08-20T00:00:00Z',sport_title:'Flag Football',sports_cats:'Flag Football,Football'},
]})};</script>`;

test('primary football variant excludes cross-tags for tackle and flag football', () => {
  const flag = {...school.sports.find(sport => sport.slug === 'womens-flag-football'), routes:['/sports/flag','/sports/flag-football'],aliases:['Flag Football']};
  const tackle = school.sports.find(sport => sport.slug === 'football');
  const flagRecords = parseOfficialNews(payload,'https://www.nccueaglepride.com/sports/flag-football/archives',school,flag).records;
  assert.deepEqual(flagRecords.map(record => record.title), ['King Named Inaugural Flag Football Head Coach']);
  const tackleRecords = parseOfficialNews(payload,'https://www.nccueaglepride.com/sports/football/archives',school,tackle).records;
  assert.deepEqual(tackleRecords.map(record => record.title), ['Eagles to Open MEAC Play at Delaware State']);
});
