#!/usr/bin/env bash
# Repliziert exakt die tar/gzip-Befehle aus server/backup.js (doBackup/doRestore)
# und prüft Archiv-Layout + Restore-Ergebnis für kritische Pfad-Konstellationen.
set -u
ROOT="$(mktemp -d)"
FAIL=0

esc() { printf '%s' "$1" | sed -E 's/[.[\]*^$\\]/\\&/g'; }

# Entspricht doBackup: pro Quelle cf/rf mit zwei Transforms, danach gzip -f
do_backup() { # $1=tarfile, rest: name:path Paare
  local tarfile="$1"; shift
  local i=0
  for pair in "$@"; do
    local name="${pair%%:*}" dir="${pair#*:}"
    local base; base="$(basename "$dir")"
    local e; e="$(esc "$base")"
    local flag=rf; [ $i -eq 0 ] && flag=cf
    tar $flag "$tarfile" --transform "s|^$e/|$name/|" --transform "s|^$e\$|$name|" -C "$(dirname "$dir")" "$base" || return 1
    i=$((i+1))
  done
  gzip -f "$tarfile"
}

# Entspricht doRestore pro Quelle
do_restore() { # $1=archive $2=name $3=target
  tar xzf "$1" -C "$3" --strip-components=1 --overwrite "$2"
}

check() { # $1=Beschreibung $2=Bedingung...
  local desc="$1"; shift
  if "$@"; then echo "  OK: $desc"; else echo "  FEHLER: $desc"; FAIL=1; fi
}

echo "=== Fall 1: Standard (Name == Basename) ==="
mkdir -p "$ROOT/c1/dms/mail-data/sub" "$ROOT/c1/dms/config"
echo "mail1" > "$ROOT/c1/dms/mail-data/m1.eml"
echo "deep" > "$ROOT/c1/dms/mail-data/sub/m2.eml"
echo "conf" > "$ROOT/c1/dms/config/postfix.cf"
do_backup "$ROOT/c1/b.tar" "mail-data:$ROOT/c1/dms/mail-data" "config:$ROOT/c1/dms/config"
members=$(tar tzf "$ROOT/c1/b.tar.gz")
check "Archiv enthält mail-data/m1.eml" grep -q '^mail-data/m1.eml$' <<<"$members"
check "Archiv enthält config/postfix.cf" grep -q '^config/postfix.cf$' <<<"$members"
mkdir -p "$ROOT/c1/restore/mail-data"
do_restore "$ROOT/c1/b.tar.gz" "mail-data" "$ROOT/c1/restore/mail-data"
check "Restore: Datei vorhanden" test -f "$ROOT/c1/restore/mail-data/m1.eml"
check "Restore: Unterordner vorhanden" test -f "$ROOT/c1/restore/mail-data/sub/m2.eml"
check "Restore: Inhalt korrekt" grep -q "mail1" "$ROOT/c1/restore/mail-data/m1.eml"

echo "=== Fall 2: Name != Basename ==="
mkdir -p "$ROOT/c2/appdata/maildata"
echo "x" > "$ROOT/c2/appdata/maildata/f.txt"
do_backup "$ROOT/c2/b.tar" "mail-data:$ROOT/c2/appdata/maildata"
members=$(tar tzf "$ROOT/c2/b.tar.gz")
check "Member unter Quellen-Namen, nicht Basename" grep -q '^mail-data/f.txt$' <<<"$members"
check "Kein Basename-Member" bash -c "! grep -q '^maildata/' <<<'$members'"

echo "=== Fall 3: Doppelte Basenames (zwei Quellen heißen 'data') ==="
mkdir -p "$ROOT/c3/a/data" "$ROOT/c3/b/data"
echo "AAA" > "$ROOT/c3/a/data/a.txt"
echo "BBB" > "$ROOT/c3/b/data/b.txt"
do_backup "$ROOT/c3/b.tar" "data-a:$ROOT/c3/a/data" "data-b:$ROOT/c3/b/data"
members=$(tar tzf "$ROOT/c3/b.tar.gz")
check "Quelle 1 unter data-a/" grep -q '^data-a/a.txt$' <<<"$members"
check "Quelle 2 unter data-b/" grep -q '^data-b/b.txt$' <<<"$members"
mkdir -p "$ROOT/c3/r-a" "$ROOT/c3/r-b"
do_restore "$ROOT/c3/b.tar.gz" "data-a" "$ROOT/c3/r-a"
do_restore "$ROOT/c3/b.tar.gz" "data-b" "$ROOT/c3/r-b"
check "Restore a getrennt" bash -c "grep -q AAA '$ROOT/c3/r-a/a.txt' && [ ! -e '$ROOT/c3/r-a/b.txt' ]"
check "Restore b getrennt" bash -c "grep -q BBB '$ROOT/c3/r-b/b.txt' && [ ! -e '$ROOT/c3/r-b/a.txt' ]"

echo "=== Fall 4: Verkettungsfalle (Name1 == Basename2) ==="
# Quelle 1: name "data", Ordner "foo" / Quelle 2: name "foo2", Ordner "data"
mkdir -p "$ROOT/c4/x/foo" "$ROOT/c4/y/data"
echo "F1" > "$ROOT/c4/x/foo/one.txt"
echo "F2" > "$ROOT/c4/y/data/two.txt"
do_backup "$ROOT/c4/b.tar" "data:$ROOT/c4/x/foo" "foo2:$ROOT/c4/y/data"
members=$(tar tzf "$ROOT/c4/b.tar.gz")
check "Quelle 1 unter data/" grep -q '^data/one.txt$' <<<"$members"
check "Quelle 2 unter foo2/ (nicht umbenannt)" grep -q '^foo2/two.txt$' <<<"$members"
check "Keine Fehlzuordnung" bash -c "! grep -qE '^(foo2/one|data/two)' <<<'$members'"

echo "=== Fall 5: Datei beginnt mit Basename + Sonderzeichen im Ordnernamen ==="
mkdir -p "$ROOT/c5/p/mail.dir"
echo "tricky" > "$ROOT/c5/p/mail.dir/mail.dirfile"
do_backup "$ROOT/c5/b.tar" "mails:$ROOT/c5/p/mail.dir"
members=$(tar tzf "$ROOT/c5/b.tar.gz")
check "Punkt im Basename escaped, Member korrekt" grep -q '^mails/mail.dirfile$' <<<"$members"
mkdir -p "$ROOT/c5/r"
do_restore "$ROOT/c5/b.tar.gz" "mails" "$ROOT/c5/r"
check "Restore mit Sonderzeichen" grep -q tricky "$ROOT/c5/r/mail.dirfile"

echo "=== Fall 6: Überschreiben bestehender Daten beim Restore ==="
echo "ALT" > "$ROOT/c1/restore/mail-data/m1.eml"
do_restore "$ROOT/c1/b.tar.gz" "mail-data" "$ROOT/c1/restore/mail-data"
check "Bestehende Datei überschrieben" grep -q "mail1" "$ROOT/c1/restore/mail-data/m1.eml"

rm -rf "$ROOT"
if [ $FAIL -eq 0 ]; then echo "ALLE TAR-TESTS BESTANDEN"; else echo "TESTS FEHLGESCHLAGEN"; exit 1; fi
