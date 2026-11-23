"""Captures the SQL the API really runs for a few village searches and saves EXPLAIN (ANALYZE, BUFFERS) for it.

Usage: python k6/tools/explain.py <output-file> "<title line>" "<code/data line>"
Env:   BASE_URL (default http://localhost:3000), POSTGRES_USER and POSTGRES_DB (read from .env when not set;
       default qaryati)

How the SQL is obtained: Postgres log_statement is set to 'all' temporarily (ALTER SYSTEM + pg_reload_conf, reset
right after), one real request per term is sent to GET /api/v1/villages?search=..., and the statements the app
executed are copied from the log. They are run with the bound parameters inlined. Run it against a local
database only: it changes a server setting for a few seconds.

A request can run more than one statement (a count and a page, and for some code paths an id lookup), so the
output has one EXPLAIN per statement. The log window is one second wide, so statements are matched to their
term by the '%term%' pattern they carry.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

OUT, TITLE, CODELINE = sys.argv[1], sys.argv[2], sys.argv[3]
BASE_URL = os.environ.get('BASE_URL', 'http://localhost:3000')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def env_value(name, default):
    if os.environ.get(name):
        return os.environ[name]
    try:
        with open(os.path.join(ROOT, '.env'), encoding='utf-8') as handle:
            for line in handle:
                if line.startswith(name + '='):
                    return line.split('=', 1)[1].strip() or default
    except OSError:
        pass
    return default


PGUSER = env_value('POSTGRES_USER', 'qaryati')
PGDATABASE = env_value('POSTGRES_DB', 'qaryati')
TERMS = [('Arabic search (term: الزيتون)', 'الزيتون'), ('English search (term: Deir)', 'Deir'),
         ('alternate-name search (term: Bayt)', 'Bayt'), ('no-match search (term: zzqnomatch)', 'zzqnomatch')]
COMPOSE = ['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', PGUSER, '-d', PGDATABASE]


def psql(sql, flags=('-tAc',)):
    r = subprocess.run(COMPOSE + list(flags) + [sql], capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout


def psql_file(sql):
    r = subprocess.run(COMPOSE + ['-P', 'pager=off'], input=sql, capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    return r.stdout + r.stderr


def get(term):
    url = BASE_URL + '/api/v1/villages?search=' + urllib.parse.quote(term)
    with urllib.request.urlopen(url, timeout=60) as resp:
        resp.read()


def log_since(ts):
    r = subprocess.run(['docker', 'compose', 'logs', '--no-log-prefix', '--since', ts, 'postgres'],
                       capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    return r.stdout


def statements(log):
    """Yields (sql, params) for every 'execute' entry that has a DETAIL parameters line."""
    lines = log.splitlines()
    i = 0
    while i < len(lines):
        m = re.search(r'LOG:\s+execute [^:]*:\s*(.*)$', lines[i])
        if not m:
            i += 1
            continue
        sql = m.group(1)
        i += 1
        while i < len(lines) and not re.match(r'^\d{4}-\d\d-\d\d ', lines[i]):
            sql += '\n' + lines[i]
            i += 1
        params = {}
        if i < len(lines) and 'DETAIL:  parameters:' in lines[i]:
            for pm in re.finditer(r"\$(\d+) = ('(?:[^']|'')*'|NULL)", lines[i]):
                params[int(pm.group(1))] = pm.group(2)
            i += 1
        yield sql, params


def inline(sql, params):
    for n in sorted(params, reverse=True):
        sql = sql.replace(f'${n}', params[n])
    return sql


psql("ALTER SYSTEM SET log_statement = 'all'")
psql('SELECT pg_reload_conf()')
captured = {}
try:
    time.sleep(1)
    for title, term in TERMS:
        # The timestamp is UTC, so it needs the trailing Z; without it docker reads it as local time.
        start = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time() - 1)) + 'Z'
        get(term)
        time.sleep(1)
        wanted = []
        for sql, params in statements(log_since(start)):
            if re.search(r'FROM "public"\."villages"|FROM villages', sql) and ('COUNT' in sql.upper() or 'LIMIT' in sql.upper()):
                text = inline(sql, params)
                if f"'%{term}%'" in text:
                    wanted.append(text)
        captured[title] = wanted
finally:
    psql('ALTER SYSTEM RESET log_statement')
    psql('SELECT pg_reload_conf()')

out = [f'EXPLAIN (ANALYZE, BUFFERS) - village search, {TITLE}', CODELINE, '',
       'The SQL was copied from the Postgres statement log (log_statement=all, set temporarily and reset), one real request',
       'per term to GET /api/v1/villages?search=..., and run here with the bound parameters inlined. A request may run',
       'more than one statement (count, page, and for some code paths an id lookup). Pager usage is off.', '',
       '=== environment ===', psql('SELECT version()'),
       psql("select count(*) || ' villages' from villages; select count(*) || ' village_names' from village_names"),
       psql("select indexname||'  '||indexdef from pg_indexes where tablename in ('villages','village_names') order by 1")]
for title, sqls in captured.items():
    if not sqls:
        out.append(f'=== {title}: NO STATEMENT CAPTURED ===')
        continue
    for n, sql in enumerate(sqls, 1):
        out.append(f'=== {title} - statement {n} of {len(sqls)} ===')
        out.append(sql.strip())
        out.append('')
        out.append(psql_file('EXPLAIN (ANALYZE, BUFFERS) ' + sql.strip().rstrip(';') + ';'))
with open(OUT, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(out))
print(json.dumps({t: len(s) for t, s in captured.items()}))
