"""Validate actual per-session human-rating-template.json records; never manufacture missing ratings.
Usage: python3 aggregate-human.py RECORD_DIRECTORY BUILD_ID
Prints an anonymous summary; input records remain in the supplied private directory.
"""
import json,sys,datetime,statistics
from pathlib import Path

def aggregate(folder,build):
    people={};seen=set();ratings={k:[] for k in ['natural','useful','notAnnoying']}
    for file in sorted(Path(folder).glob('*.json')):
        row=json.loads(file.read_text())
        if row.get('templateOnly') is not False: raise ValueError(f'{file.name}: template or unconfirmed record')
        if row.get('buildId')!=build: raise ValueError(f'{file.name}: wrong candidate')
        for key in ['participantId','sessionId','reviewer','mode','platform']:
            if not isinstance(row.get(key),str) or not row[key].strip():raise ValueError(f'{file.name}: missing {key}')
        if row['sessionId'] in seen:raise ValueError('Duplicate session')
        seen.add(row['sessionId'])
        start=datetime.datetime.fromisoformat(row['startedAt'].replace('Z','+00:00'));end=datetime.datetime.fromisoformat(row['completedAt'].replace('Z','+00:00'))
        if start.tzinfo is None or end.tzinfo is None or end<=start or end>datetime.datetime.now(datetime.timezone.utc):raise ValueError('Invalid session dates')
        for key in ratings:
            value=row['ratings'].get(key)
            if type(value) is not int or not 1<=value<=5:raise ValueError(f'Invalid {key}')
            ratings[key].append(value)
        people.setdefault(row['participantId'],[]).append(row)
    opinions={k:[] for k in ['useAgain','wouldMiss']}
    for sessions in people.values():
        sessions.sort(key=lambda r:datetime.datetime.fromisoformat(r['completedAt'].replace('Z','+00:00')))
        eligible=sessions[2:]
        final=next((r['afterThreeSessions'] for r in reversed(eligible) if all(type(r.get('afterThreeSessions',{}).get(k)) is bool for k in opinions)),None)
        if final:
            for key in opinions: opinions[key].append(final[key])
    counts=[len(rows) for rows in people.values()]
    complete=len(people)>=15 and min(counts,default=0)>=3 and all(len(v)==len(people) for v in opinions.values())
    return {'buildId':build,'dataStatus':'COMPLETE' if complete else 'BLOCKED_MISSING_PARTICIPANTS_SESSIONS_OR_ANSWERS','participants':len(people),'sessions':len(seen),'minimumSessionsPerPerson':min(counts,default=0),'ratings':{k:{'mean':statistics.mean(v) if v else None,'samples':len(v)} for k,v in ratings.items()},'afterThreeSessions':{k:{'ratio':statistics.mean(v) if v else None,'participants':len(v)} for k,v in opinions.items()}}
if __name__=='__main__':
    if len(sys.argv)!=3:raise SystemExit(__doc__)
    try:print(json.dumps(aggregate(sys.argv[1],sys.argv[2]),ensure_ascii=False,indent=2))
    except (ValueError,KeyError,TypeError) as e:raise SystemExit(str(e))
