import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const FOOTBALL_API_KEY = Deno.env.get('FOOTBALL_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Maps football-data.org team names → app team names
const NAME: Record<string, string> = {
  'Bosnia-Herzegovina': 'Bosnia',
  'Cape Verde Islands': 'Cape Verde',
  'Congo DR': 'DR Congo',
  'Turkey': 'Türkiye',
  'United States': 'USA',
}

// All 72 group-stage matches: id matches the app's GM[id] exactly
const GM = [
  {id:1,  h:'Mexico',       a:'South Africa'},
  {id:2,  h:'South Korea',  a:'Czechia'},
  {id:3,  h:'Czechia',      a:'South Africa'},
  {id:4,  h:'Mexico',       a:'South Korea'},
  {id:5,  h:'Czechia',      a:'Mexico'},
  {id:6,  h:'South Africa', a:'South Korea'},
  {id:7,  h:'Canada',       a:'Bosnia'},
  {id:8,  h:'Qatar',        a:'Switzerland'},
  {id:9,  h:'Switzerland',  a:'Bosnia'},
  {id:10, h:'Canada',       a:'Qatar'},
  {id:11, h:'Switzerland',  a:'Canada'},
  {id:12, h:'Bosnia',       a:'Qatar'},
  {id:13, h:'Brazil',       a:'Morocco'},
  {id:14, h:'Haiti',        a:'Scotland'},
  {id:15, h:'Scotland',     a:'Morocco'},
  {id:16, h:'Brazil',       a:'Haiti'},
  {id:17, h:'Scotland',     a:'Brazil'},
  {id:18, h:'Morocco',      a:'Haiti'},
  {id:19, h:'USA',          a:'Paraguay'},
  {id:20, h:'Australia',    a:'Türkiye'},
  {id:21, h:'USA',          a:'Australia'},
  {id:22, h:'Türkiye',      a:'Paraguay'},
  {id:23, h:'Türkiye',      a:'USA'},
  {id:24, h:'Paraguay',     a:'Australia'},
  {id:25, h:'Germany',      a:'Curaçao'},
  {id:26, h:'Ivory Coast',  a:'Ecuador'},
  {id:27, h:'Germany',      a:'Ivory Coast'},
  {id:28, h:'Ecuador',      a:'Curaçao'},
  {id:29, h:'Ecuador',      a:'Germany'},
  {id:30, h:'Curaçao',      a:'Ivory Coast'},
  {id:31, h:'Netherlands',  a:'Japan'},
  {id:32, h:'Sweden',       a:'Tunisia'},
  {id:33, h:'Netherlands',  a:'Sweden'},
  {id:34, h:'Tunisia',      a:'Japan'},
  {id:35, h:'Japan',        a:'Sweden'},
  {id:36, h:'Tunisia',      a:'Netherlands'},
  {id:37, h:'Belgium',      a:'Egypt'},
  {id:38, h:'Iran',         a:'New Zealand'},
  {id:39, h:'Belgium',      a:'Iran'},
  {id:40, h:'New Zealand',  a:'Egypt'},
  {id:41, h:'Egypt',        a:'Iran'},
  {id:42, h:'New Zealand',  a:'Belgium'},
  {id:43, h:'Spain',        a:'Cape Verde'},
  {id:44, h:'Saudi Arabia', a:'Uruguay'},
  {id:45, h:'Spain',        a:'Saudi Arabia'},
  {id:46, h:'Uruguay',      a:'Cape Verde'},
  {id:47, h:'Cape Verde',   a:'Saudi Arabia'},
  {id:48, h:'Uruguay',      a:'Spain'},
  {id:49, h:'France',       a:'Senegal'},
  {id:50, h:'Iraq',         a:'Norway'},
  {id:51, h:'France',       a:'Iraq'},
  {id:52, h:'Norway',       a:'Senegal'},
  {id:53, h:'Norway',       a:'France'},
  {id:54, h:'Senegal',      a:'Iraq'},
  {id:55, h:'Argentina',    a:'Algeria'},
  {id:56, h:'Austria',      a:'Jordan'},
  {id:57, h:'Argentina',    a:'Austria'},
  {id:58, h:'Jordan',       a:'Algeria'},
  {id:59, h:'Algeria',      a:'Austria'},
  {id:60, h:'Jordan',       a:'Argentina'},
  {id:61, h:'Portugal',     a:'DR Congo'},
  {id:62, h:'Uzbekistan',   a:'Colombia'},
  {id:63, h:'Portugal',     a:'Uzbekistan'},
  {id:64, h:'Colombia',     a:'DR Congo'},
  {id:65, h:'Colombia',     a:'Portugal'},
  {id:66, h:'DR Congo',     a:'Uzbekistan'},
  {id:67, h:'England',      a:'Croatia'},
  {id:68, h:'Ghana',        a:'Panama'},
  {id:69, h:'England',      a:'Ghana'},
  {id:70, h:'Panama',       a:'Croatia'},
  {id:71, h:'Panama',       a:'England'},
  {id:72, h:'Croatia',      a:'Ghana'},
]

// Build lookup: "HomeTeam|AwayTeam" → app match id
const LOOKUP = new Map(GM.map(m => [`${m.h}|${m.a}`, m.id]))

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Fetch all WC matches from football-data.org
  const apiRes = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
    headers: { 'X-Auth-Token': FOOTBALL_API_KEY },
  })
  if (!apiRes.ok) {
    return new Response(`API error: ${apiRes.status}`, { status: 502 })
  }
  const { matches } = await apiRes.json()

  // Load current results from DB
  const { data: row } = await supabase
    .from('wc26_store')
    .select('value')
    .eq('key', 'wc26_r')
    .maybeSingle()

  const results: Record<string, { home: number; away: number }> = (row?.value as any) ?? {}
  let changed = false
  let synced = 0

  for (const m of matches) {
    if (m.status !== 'FINISHED' && m.status !== 'IN_PLAY') continue
    const score = m.score?.fullTime
    if (score?.home == null || score?.away == null) continue

    const homeN = NAME[m.homeTeam?.name] ?? m.homeTeam?.name
    const awayN = NAME[m.awayTeam?.name] ?? m.awayTeam?.name
    if (!homeN || !awayN) continue

    const id = LOOKUP.get(`${homeN}|${awayN}`)
    if (!id) continue

    const cur = results[id]
    if (!cur || cur.home !== score.home || cur.away !== score.away) {
      results[id] = { home: score.home, away: score.away }
      changed = true
    }
    synced++
  }

  if (changed) {
    await supabase.from('wc26_store').upsert(
      { key: 'wc26_r', value: results, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
  }

  return new Response(
    JSON.stringify({ ok: true, changed, synced, total: Object.keys(results).length }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
