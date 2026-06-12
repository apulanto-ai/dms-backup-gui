# 📬 DMS Backup GUI

**Aktuelle Version: v1.2.0** (siehe [Changelog](#-changelog))

Eine moderne Web-Oberfläche für [docker-mailserver (DMS)](https://github.com/docker-mailserver/docker-mailserver) – speziell für Setups ohne GUI (z. B. unter **Unraid**). Ein einziger Container liefert drei Oberflächen:

- 🛡️ **Backup & Restore** – DMS-Daten sichern, wiederherstellen, herunterladen, hochladen und automatisch nach Zeitplan sichern
- 👥 **Verwaltung** – E-Mail-Konten anlegen/löschen, Passwörter ändern, Aliasse und Quotas verwalten
- ✉️ **Webmail** – vollwertiger Mail-Client direkt im Browser (IMAP/SMTP gegen den DMS)

Beide Oberflächen teilen sich ein anpassbares, modernes Design: **Dark Mode / Light Mode / Auto**, freie **Akzentfarbe** (8 Vorgaben + eigener Farbwähler), drei **Design-Stile** (✨ Aurora mit Glas-Effekt, ▪️ Flat, 🫧 Soft) und einstellbare **Dichte**.

---

## ✨ Funktionen

### Backup & Restore
- Backup aller DMS-Verzeichnisse (Mail-Daten, Mail-State, Konfiguration, Logs) als `tar.gz`
- **Konfigurierbare Quellen per Dialog:** Welche Pfade gesichert werden, wird direkt in der GUI eingestellt (⚙️ an der Quellen-Karte) – inklusive **Ordner-Browser** zum Durchklicken. Die Einstellungen werden persistent im Backup-Volume gespeichert.
- Wiederherstellung per Klick – optional wird der DMS-Container währenddessen automatisch **gestoppt und neu gestartet** (über den Docker-Socket)
- **Zeitgesteuerte Backups** per Cron-Ausdruck, inkl. Aufbewahrungsregel (behalte die letzten *N* Backups)
- Backups **herunterladen** (Offsite-Kopie) und **hochladen** (Restore auf neuem System)
- Live-Protokoll laufender Backup-/Restore-Jobs
- Dashboard: letzte Sicherung, Gesamtgröße, Container-Status, Quellen-Übersicht
- Geschützt per Admin-Passwort

### Verwaltung (Admin-Panel)
- **E-Mail-Konten** auflisten (mit Postfachgröße), anlegen, löschen – optional inklusive Mail-Daten
- **Passwörter ändern** mit Generator für sichere Zufallspasswörter
- **Aliasse** anlegen und entfernen (auch mehrere Ziele pro Alias)
- **Quotas** pro Konto setzen (z. B. `500M`, `2G`)
- Arbeitet direkt auf den DMS-Dateien `postfix-accounts.cf`, `postfix-virtual.cf` und `dovecot-quotas.cf` (SHA512-CRYPT-Hashes wie `setup email add`) – der **Change-Detector des DMS übernimmt Änderungen automatisch**, ein Docker-Socket ist dafür nicht nötig
- Geschützt durch dieselbe Admin-Anmeldung wie Backup & Restore

### Webmail
- Anmeldung mit beliebigem DMS-Postfach (IMAP)
- Ordnerliste mit Ungelesen-Zählern, Nachrichtenliste mit Suche und Paginierung
- HTML-Mails (sandboxed & sanitized) und Text-Mails, Anhänge herunterladen
- Verfassen, Antworten, Weiterleiten, Löschen (in Papierkorb), gesendete Mails landen im „Gesendet“-Ordner
- Responsive – auch am Handy nutzbar

---

## 🚀 Installation

### Unraid

1. **Docker-Tab → Add Container** (oder per Compose-Plugin, siehe unten)
2. Repository: `ghcr.io/apulanto-ai/dms-backup-gui:latest` *(alternativ selbst bauen, siehe unten)*
3. Netzwerk: Die GUI lauscht auf **Port 80**. Mit eigener Container-IP (Unraid-Bridge `br0`/macvlan) ist kein Port-Mapping nötig; im normalen Bridge-Modus z. B. `8080 → 80` mappen.
4. Pfade mappen (Container-Pfad → Host-Pfad):

   | Container-Pfad | Host-Pfad (Beispiel Unraid) | Zweck |
   |---|---|---|
   | `/backups` | `/mnt/user/backups/dms` | Backup-Ablage (enthält auch die GUI-Einstellungen) |
   | `/dms` | `/mnt/user/appdata/dms` | DMS-Daten (ein Mount genügt) |
   | `/var/run/docker.sock` | `/var/run/docker.sock` | optional, für Container-Stopp beim Restore |

5. Variablen setzen (siehe Tabelle unten), mindestens `ADMIN_PASSWORD`, `IMAP_HOST` und `DMS_CONTAINER`
6. Starten, `http://<container-ip>/` (bzw. `http://<unraid-ip>:8080`) öffnen 🎉
7. Im Backup-Tab über **⚙️ Konfigurieren** prüfen/festlegen, welche Unterordner gesichert werden – der Ordner-Browser zeigt dabei direkt den Container-Inhalt unter `/dms`

### Docker Compose

Siehe [docker-compose.yml](docker-compose.yml) im Repository – Pfade anpassen, dann:

```bash
docker compose up -d
```

### Selbst bauen

```bash
git clone https://github.com/apulanto-ai/dms-backup-gui.git
cd dms-backup-gui
docker build -t dms-backup-gui .
```

---

## ⚙️ Umgebungsvariablen

| Variable | Standard | Beschreibung |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` ⚠️ | Passwort für die Backup-Verwaltung – **unbedingt ändern!** |
| `DMS_CONTAINER` | – | Name des DMS-Containers (z. B. `mailserver`); aktiviert Stopp/Start beim Restore |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Pfad zum Docker-Socket |
| `DMS_CONFIG_DIR` | automatisch | Pfad zum DMS-Konfigurationsverzeichnis (Standard: Backup-Quelle `config`, sonst `/dms/config`); per GUI änderbar |
| `DMS_MAIL_DIR` | automatisch | Pfad zu den DMS-Mail-Daten (Standard: Backup-Quelle `mail-data`, sonst `/dms/mail-data`); per GUI änderbar |
| `IMAP_HOST` | – | IMAP-Server für Webmail (Hostname/IP des DMS) – ohne diese Variable ist Webmail deaktiviert |
| `IMAP_PORT` | `993` | IMAP-Port |
| `IMAP_SECURE` | `true` | `true` = TLS (993), `false` = STARTTLS/Plain (143) |
| `SMTP_HOST` | = `IMAP_HOST` | SMTP-Server für den Versand |
| `SMTP_PORT` | `465` | SMTP-Port |
| `SMTP_SECURE` | `true` | `true` = TLS (465) |
| `TLS_REJECT_UNAUTHORIZED` | `true` | Auf `false` setzen bei selbstsignierten Zertifikaten |
| `BACKUP_DIR` | `/backups` | Ablageort der Backups im Container |
| `SOURCES` | siehe unten | *Standard*-Backup-Quellen als `name:pfad,name:pfad` – in der GUI gespeicherte Quellen (⚙️-Dialog) haben Vorrang |
| `BACKUP_CRON` | `0 3 * * *` | Standard-Cron für automatische Backups (per GUI änderbar) |
| `RETENTION` | `14` | Standard-Aufbewahrung (Anzahl Backups, per GUI änderbar) |
| `PORT` | `80` | HTTP-Port der Oberfläche |

Standard-`SOURCES`:
```
mail-data:/dms/mail-data,mail-state:/dms/mail-state,config:/dms/config,mail-logs:/dms/mail-logs
```
Die Quellen lassen sich jederzeit im **⚙️-Konfigurationsdialog** der GUI ändern (mit Ordner-Browser); sie werden in `BACKUP_DIR/.settings.json` gespeichert und überleben damit Container-Updates. Nicht vorhandene Quellen werden beim Backup automatisch übersprungen.

---

## 🎨 Darstellung anpassen

Oben rechts auf **🎨** klicken:

- **Modus:** ☀️ Hell · 🌙 Dunkel · 🖥️ Auto (folgt dem System)
- **Akzentfarbe:** 8 Farbvorgaben oder freie Farbwahl per Color-Picker
- **Design:** ✨ Aurora (Glas & animierte Farbverläufe) · ▪️ Flat (klar & minimal) · 🫧 Soft (rund & weich)
- **Dichte:** Komfortabel · Kompakt

Die Einstellungen werden lokal im Browser gespeichert.

---

## 🔒 Sicherheitshinweise

- Die Oberfläche ist für das **LAN/Heimnetz** gedacht. Für Zugriff von außen unbedingt einen Reverse-Proxy mit HTTPS (z. B. Nginx Proxy Manager, SWAG, Traefik) und ggf. zusätzliche Authentifizierung vorschalten.
- `ADMIN_PASSWORD` setzen – ohne die Variable gilt das Standardpasswort `admin`.
- Der Docker-Socket gibt dem Container weitreichende Rechte. Wer das nicht möchte, lässt den Mount weg – Restores funktionieren dann trotzdem, der DMS-Container sollte dabei aber manuell gestoppt werden.
- Webmail-Zugangsdaten werden nur im Arbeitsspeicher des Containers gehalten (Session, 8 h), nie gespeichert.

## 💡 Hinweise zur Verwaltung

- Konten/Aliasse/Quotas werden in den DMS-Konfigurationsdateien gespeichert; der DMS-Change-Detector lädt Postfix/Dovecot automatisch neu (typisch innerhalb weniger Sekunden).
- Die GUI braucht dafür Schreibzugriff auf das Config-Verzeichnis – beim empfohlenen Mount `/dms` ist das bereits gegeben.
- Beim Löschen eines Kontos kann optional das Postfach (Maildir) mit entfernt werden – das ist unwiderruflich, vorher ggf. ein Backup erstellen.

## 💡 Hinweise zu Backup & Restore

- Backups sind konsistenter, wenn während des Backups wenig Mailverkehr herrscht (z. B. nachts um 3 Uhr).
- Beim **Restore** wird der Archivinhalt über die bestehenden Daten entpackt. Empfohlen: Option „DMS-Container stoppen“ aktiviert lassen.
- Ein Backup enthält pro Quelle ein Top-Level-Verzeichnis (`mail-data/`, `config/` …) und lässt sich daher zur Not auch manuell mit `tar -xzf` entpacken.

---

## 🧱 Technik

- **Backend:** Node.js 22, Express, ImapFlow, Nodemailer, Mailparser, node-cron, unixcrypt (SHA512-CRYPT)
- **Frontend:** Vanilla JS SPA, CSS Custom Properties für das Theme-System (keine Build-Toolchain nötig)
- **Image:** `node:22-alpine` + GNU tar, Healthcheck inklusive

---

## 📋 Changelog

| Version | Datum | Änderungen |
|---|---|---|
| **v1.2.0** | 2026-06-12 | **Admin-Panel „👥 Verwaltung“**: E-Mail-Konten anlegen/löschen (optional inkl. Maildir), Passwörter ändern (mit Passwort-Generator), Aliasse und Quotas verwalten – dateibasiert auf `postfix-accounts.cf`/`postfix-virtual.cf`/`dovecot-quotas.cf` mit SHA512-CRYPT, kein Docker-Socket nötig; DMS-Pfade in der GUI konfigurierbar |
| **v1.1.0** | 2026-06-12 | Backup-Quellen per **Konfigurationsdialog** in der GUI einstellbar (Name + Pfad, Ordner-Browser, Standardwerte, persistent in `BACKUP_DIR/.settings.json`); Standard-Port auf **80** geändert (eigene Container-IP → kein Mapping nötig); robusteres Archivformat bei frei konfigurierten Pfaden |
| **v1.0.0** | 2026-06-11 | Erstveröffentlichung: Backup/Restore mit Zeitplan, Aufbewahrung, Up-/Download, Docker-Container-Steuerung; Webmail (Lesen, Suchen, Verfassen, Antworten, Weiterleiten, Anhänge); Theme-System mit Dark/Light/Auto, Akzentfarben und drei Design-Stilen |

---

## 📄 Lizenz

[MIT](LICENSE)
