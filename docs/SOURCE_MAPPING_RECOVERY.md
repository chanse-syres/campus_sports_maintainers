# Reviewed source mapping recovery

Observed at 2026-09-27T01:36:54.568Z.

This change repairs 82 program source mappings across 25 schools: 80 previously undiscovered feeds and two existing source-format failures. Each changed source was linked by that school's public official navigation and returned nonempty, sport-scoped article metadata in a bounded local collection check. All other stored program mappings remain unchanged. These are local source observations; publication and hosted-run health require separate verification.

Texas's official menu uses **Track & Field/Cross Country** for its shared program page. The six NCAA XC/indoor/outdoor program rows each parsed 29 articles with publisher photos; the newest was dated September 25, 2026. Combined programs retain the publisher's shared category. Explicit opposite-gender metadata and explicit indoor/outdoor routes remain scoped; article headlines do not override the publisher's sport classification.

The shared matcher now recognizes observed complete combined XC/track labels, full indoor/outdoor menu suffixes, gendered menu headings, Swim & Dive, artistic swimming, and gendered water-polo abbreviations. It does not infer women’s teams from men’s URLs or turn generic wrestling links into both genders.

| School | Repaired program mappings | Sample verified collection |
| --- | ---: | --- |
| brown-university | 2 | [Official source](https://www.brownbears.com/index.aspx?path=mwpolo) |
| california-state-university-fullerton | 2 | [Official source](https://www.fullertontitans.com/sports/indoor-track-and-field/archives) |
| coastal-carolina-university | 5 | [Official source](https://www.goccusports.com/sports/track-and-field) |
| creighton-university | 4 | [Official source](https://gocreighton.com/sports/mens-cross-country) |
| delaware-state-university | 1 | [Official source](https://www.dsuhornets.com/sports/outdoor-track/archives) |
| florida-state-university | 2 | [Official source](https://www.seminoles.com/sports/track-and-field) |
| george-washington-university | 3 | [Official source](https://www.gwsports.com/sports/mens-cross-country/archives) |
| georgia-southern-university | 3 | [Official source](https://gseagles.com/sports/cross-country) |
| iona-university | 1 | [Official source](https://www.ionagaels.com/sports/womens-rowing/archives) |
| siena-university | 6 | [Official source](https://www.sienasaints.com/sports/cross-country/archives) |
| southern-university-baton-rouge | 2 | [Official source](https://www.gojagsports.com/index.aspx?path=cxc) |
| stanford-university | 1 | [Official source](https://gostanford.com/sports/artistic-swimming/news) |
| stetson-university | 3 | [Official source](https://www.gohatters.com/sports/cross-country/archives) |
| texas-tech | 6 | [Official source](https://www.texastech.com/sports/cross-country/archives) |
| the-ohio-state-university | 3 | [Official source](https://ohiostatebuckeyes.com/sports/mens-swim-dive) |
| the-university-of-north-carolina-at-greensboro | 4 | [Official source](https://www.uncgspartans.com/sports/track-and-field/archives) |
| university-of-alabama | 6 | [Official source](https://www.rolltide.com/sports/xctrack) |
| university-of-california-davis | 3 | [Official source](https://www.ucdavisaggies.com/index.aspx?path=itrack) |
| university-of-iowa | 1 | [Official source](https://www.hawkeyesports.com/sports/wrestling/news) |
| university-of-massachusetts-lowell | 2 | [Official source](https://www.goriverhawks.com/sports/mens-track-and-field) |
| university-of-north-texas | 6 | [Official source](https://www.meangreensports.com/sports/track-and-field) |
| university-of-northern-colorado | 4 | [Official source](https://uncbears.com/sports/mens-indoor-track-field) |
| university-of-tennessee-at-chattanooga | 2 | [Official source](https://www.gomocs.com/sports/cross-country) |
| university-of-texas-at-austin | 6 | [Official source](https://www.texaslonghorns.com/sports/track-and-field) |
| washington-state-university | 4 | [Official source](https://www.wsucougars.com/sports/track-and-field/news) |

## Limits

The bounded check considered 116 newly discoverable candidate mappings and five existing format failures from already-observed homepages. Thirty-six new candidates and three existing format failures did not yield scoped records and were not persisted. Other undiscovered routes, access denials, stale publisher dates, and unsupported classifications remain visible health gaps. A source returning records does not imply that the publisher has posted recently.

With the companion shared-archive parser fix, Middle Tennessee's four existing track feeds also parsed successfully from the official archive's declared sport metadata: 31 records for each men's season and 14 for each women's season. These four do not require registry changes and are separate from the 82 mappings above.

No account credentials, cookies, new source hosts, article bodies, or additional publication permissions are introduced.
