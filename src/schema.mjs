const text = (maxLength = 300) => ({ type: 'string', minLength: 1, maxLength });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const url = { type: 'string', minLength: 10, maxLength: 2048, pattern: '^https://' };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const newsRecord = object({ id: text(80), title: text(), url, discoverySourceUrl: url, publishedAt: nullable(date), publishedAtPrecision: { enum: ['day', 'instant', 'unknown'] }, imageUrl: nullable(url), imageAlt: nullable(text()), publisher: text(160) });
const scheduleRecord = object({ id: text(80), date, name: text(), status: text(80), venue: nullable(text()), homeAway: { enum: ['home', 'away', 'neutral', null] }, opponent: text(), teamScore: nullable({ type: 'number', minimum: 0, maximum: 999 }), opponentScore: nullable({ type: 'number', minimum: 0, maximum: 999 }), url: nullable(url) });
scheduleRecord.properties.datePrecision = { enum: ['day', 'instant', 'unknown'] };
const rosterRecord = object({ id: text(80), name: text(160), position: nullable(text(30)), jersey: nullable(text(10)), year: nullable(text(40)), imageUrl: nullable(url), url: nullable(url) });
// Only fields displayed by the named provider are populated; null means unknown.
const rank = nullable({ type: 'integer', minimum: 1, maximum: 100000 });
const recruitRecord = object({ id: text(80), name: text(160), classYear: { type: 'integer', minimum: 2000, maximum: 2100 }, position: nullable(text(30)), status: { enum: ['offered', 'committed', 'signed', 'enrolled', 'unknown'] }, schoolId: text(100), sport: text(100), sourceUrl: url, updatedAt: date,
  profileUrl: nullable(url), imageUrl: nullable(url), schoolName: nullable(text(160)), hometown: nullable(text(160)),
  rating: nullable({ type: 'number', minimum: 0, maximum: 100 }), ratingSystem: { enum: ['247sports', null] },
  stars: nullable({ type: 'integer', minimum: 1, maximum: 5 }), nationalRank: rank, positionRank: rank, stateRank: rank,
  rankingState: nullable({ type: 'string', pattern: '^[A-Z]{2}$' }), rankingGroup: nullable(text(40)),
});
export const datasetSchema = (record, maxItems = 400) => object({ status: { enum: ['ok', 'empty', 'stale', 'unavailable', 'unsupported'] }, lastAttemptAt: date, lastSuccessAt: nullable(date), sourceUrl: nullable(url), season: nullable(text(40)), reason: nullable(text(160)), records: { type: 'array', maxItems, items: record } });
const sourceHealth = object({ status: { enum: ['ok', 'empty', 'stale', 'unavailable'] }, lastAttemptAt: date, lastSuccessAt: nullable(date), sourceUrl: url, reason: nullable(text(160)), recordCount: { type: 'integer', minimum: 0, maximum: 1000 } });
const newsDataset = datasetSchema(newsRecord, 1000);
newsDataset.properties.sources = { type: 'array', maxItems: 20, items: sourceHealth };
newsDataset.required.push('sources');
const conference = object({ slug: text(100), name: text(160) });
const sport = object({ sponsored: {const:true}, code:text(30), name:text(100), gender:text(30), conference,
  news: newsDataset, schedule:datasetSchema(scheduleRecord), roster:datasetSchema(rosterRecord),
  recruitingAnnouncements:datasetSchema(newsRecord), recruitingBoard:datasetSchema(recruitRecord,1000), recruitingOffers:datasetSchema(recruitRecord,1000) });
export const snapshotSchema = {
  $schema:'http://json-schema.org/draft-07/schema#',
  $id:'https://github.com/chanse-syres/campus_sports_maintainers/schemas/snapshot.schema.json',
  ...object({schemaVersion:{const:1},academicYear:text(20),conference,
    school:object({slug:text(100),ncaaId:text(20),name:text(160),athleticsUrl:nullable(url),membershipSourceUrl:url}),generatedAt:date,
    sports:{type:'object',minProperties:1,maxProperties:60,patternProperties:{'^[a-z0-9]+(?:-[a-z0-9]+)*$':sport},additionalProperties:false}}),
};
