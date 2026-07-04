"""
Score sync: football-data.org → Supabase wc26_r
Runs every 5 minutes via Render Cron Job (also triggered by GitHub Actions as backup).
"""
import os, json, urllib.request
from datetime import datetime, timedelta, timezone

FDAPI  = os.environ['FOOTBALL_API_KEY']
SB_URL = os.environ['SUPABASE_URL']
SB_KEY = os.environ['SUPABASE_ANON_KEY']

NAMES = {
    'Bosnia-Herzegovina': 'Bosnia',
    'Cape Verde Islands': 'Cape Verde',
    'Congo DR':           'DR Congo',
    "Côte d'Ivoire":      'Ivory Coast',
    'Turkey':             'Türkiye',
    'United States':      'USA',
}

LOOKUP = {
    'Mexico|South Africa':1,'South Korea|Czechia':2,'Czechia|South Africa':3,
    'Mexico|South Korea':4,'Czechia|Mexico':5,'South Africa|South Korea':6,
    'Canada|Bosnia':7,'Qatar|Switzerland':8,'Switzerland|Bosnia':9,
    'Canada|Qatar':10,'Switzerland|Canada':11,'Bosnia|Qatar':12,
    'Brazil|Morocco':13,'Haiti|Scotland':14,'Scotland|Morocco':15,
    'Brazil|Haiti':16,'Scotland|Brazil':17,'Morocco|Haiti':18,
    'USA|Paraguay':19,'Australia|Türkiye':20,'USA|Australia':21,
    'Türkiye|Paraguay':22,'Türkiye|USA':23,'Paraguay|Australia':24,
    'Germany|Curaçao':25,'Ivory Coast|Ecuador':26,'Germany|Ivory Coast':27,
    'Ecuador|Curaçao':28,'Ecuador|Germany':29,'Curaçao|Ivory Coast':30,
    'Netherlands|Japan':31,'Sweden|Tunisia':32,'Netherlands|Sweden':33,
    'Tunisia|Japan':34,'Japan|Sweden':35,'Tunisia|Netherlands':36,
    'Belgium|Egypt':37,'Iran|New Zealand':38,'Belgium|Iran':39,
    'New Zealand|Egypt':40,'Egypt|Iran':41,'New Zealand|Belgium':42,
    'Spain|Cape Verde':43,'Saudi Arabia|Uruguay':44,'Spain|Saudi Arabia':45,
    'Uruguay|Cape Verde':46,'Cape Verde|Saudi Arabia':47,'Uruguay|Spain':48,
    'France|Senegal':49,'Iraq|Norway':50,'France|Iraq':51,
    'Norway|Senegal':52,'Norway|France':53,'Senegal|Iraq':54,
    'Argentina|Algeria':55,'Austria|Jordan':56,'Argentina|Austria':57,
    'Jordan|Algeria':58,'Algeria|Austria':59,'Jordan|Argentina':60,
    'Portugal|DR Congo':61,'Uzbekistan|Colombia':62,'Portugal|Uzbekistan':63,
    'Colombia|DR Congo':64,'Colombia|Portugal':65,'DR Congo|Uzbekistan':66,
    'England|Croatia':67,'Ghana|Panama':68,'England|Ghana':69,
    'Panama|Croatia':70,'Panama|England':71,'Croatia|Ghana':72,
}

def fetch_matches():
    today = datetime.now(timezone.utc).date()
    d_from = (today - timedelta(days=1)).isoformat()
    d_to   = (today + timedelta(days=1)).isoformat()
    req = urllib.request.Request(
        f'https://api.football-data.org/v4/competitions/WC/matches?dateFrom={d_from}&dateTo={d_to}',
        headers={'X-Auth-Token': FDAPI}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())['matches']

def load_results():
    req = urllib.request.Request(
        f'{SB_URL}/rest/v1/wc26_store?key=eq.wc26_r&select=value',
        headers={'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}'}
    )
    with urllib.request.urlopen(req) as resp:
        rows = json.loads(resp.read())
    return rows[0]['value'] if rows else {}

def save_results(results):
    body = json.dumps({
        'key': 'wc26_r',
        'value': results,
        'updated_at': datetime.utcnow().isoformat() + 'Z',
    })
    req = urllib.request.Request(
        f'{SB_URL}/rest/v1/wc26_store',
        data=body.encode(),
        headers={
            'apikey': SB_KEY,
            'Authorization': f'Bearer {SB_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
        },
        method='POST'
    )
    with urllib.request.urlopen(req) as resp:
        print(f'Written {len(results)} results. HTTP {resp.status}')

# Verified real-world scores for KO matches where football-data.org's free tier
# is unreliable (usually ET / penalty shootouts). `manual: True` protects them
# from future sync overwrites.
MANUAL_OVERRIDES = {
    # Australia 1-1 Egypt (AET) — Egypt won 4-2 on pens (Jul 3, R32)
    '114': {'home': 1, 'away': 1, 'status': 'FINISHED', 'et': True, 'adv': 'a', 'manual': True},
    # Argentina 3-2 Cape Verde (AET) — Argentina won in ET (Jul 3, R32)
    '115': {'home': 3, 'away': 2, 'status': 'FINISHED', 'et': True, 'manual': True},
}

def main():
    matches  = fetch_matches()
    results  = load_results()
    changed  = False

    for m in matches:
        status = m['status']
        if status not in ('FINISHED', 'IN_PLAY'):
            continue

        h = NAMES.get(m['homeTeam']['name'], m['homeTeam']['name'])
        a = NAMES.get(m['awayTeam']['name'], m['awayTeam']['name'])
        mid = LOOKUP.get(f'{h}|{a}')
        if not mid:
            continue
        key = str(mid)

        # Respect admin overrides — sync must never clobber manually-entered results
        if results.get(key, {}).get('manual'):
            continue

        if status == 'FINISHED':
            sc = (m.get('score') or {}).get('fullTime') or {}
            if sc.get('home') is None or sc.get('away') is None:
                continue
            entry = {'home': sc['home'], 'away': sc['away'], 'status': 'FINISHED'}
        else:  # IN_PLAY — halfTime is best available on free API tier
            ht = (m.get('score') or {}).get('halfTime') or {}
            entry = {
                'home': ht['home'] if ht.get('home') is not None else 0,
                'away': ht['away'] if ht.get('away') is not None else 0,
                'status': 'IN_PLAY',
            }
            # Never overwrite a final score with a live one
            if results.get(key, {}).get('status') == 'FINISHED':
                continue

        if results.get(key) != entry:
            results[key] = entry
            changed = True
            print(f'  Updated match {key} ({h} vs {a}): {entry}')

    # Apply verified overrides (source of truth for API-unreliable ET/pens matches)
    for k, v in MANUAL_OVERRIDES.items():
        if results.get(k) != v:
            results[k] = v
            changed = True
            print(f'  MANUAL OVERRIDE applied for id={k}: {v}')

    if changed:
        save_results(results)
    else:
        print('No changes.')

if __name__ == '__main__':
    main()
