# Änderungsprotokoll

Wichtige Änderungen, die neuesten zuerst. Die Deploy-Pipeline verweigert einen Release, solange der Abschnitt „Unreleased“ leer ist, und versieht ihn mit der veröffentlichten Version.

## Unreleased

## v1.0.12 - 2026-10-10

- Das Änderungsprotokoll unter Einstellungen > Über listet die Hinweise der installierten Version auf; in v1.0.11 endete es noch bei v1.0.10, sowohl in der Desktop-App als auch auf der Remote-Webseite.

- Das Änderungsprotokoll ist in jeder App-Sprache verfügbar, und nach einem Update zeigt die App einmalig, was in dieser Version neu ist.

- Automatisches Reasoning ist bei unterstützten Modellen standardmäßig aktiviert: Jede Nachricht und jeder Tool-Schritt erhält den Reasoning-Aufwand, den er braucht. Sein Modell wird bei der ersten Nutzung im Hintergrund heruntergeladen statt beim Start, und die Karte Integriert zeigt das Modell und seine Grundlage.

- Dateilinks in einer Unterhaltung öffnen sich daneben im Seitenbereich als Tabs. Ein neuer Link ersetzt den Vorschau-Tab, sodass sich keine Tabs mehr ansammeln; ein Tab bleibt erhalten, sobald Sie ihn doppelt anklicken, Geöffnet lassen wählen oder die Datei bearbeiten. Höchstens acht Datei-Tabs bleiben geöffnet. Einstellungen > Allgemein > Link-Vorschau schaltet dies ab.

- CSV- und TSV-Dateien öffnen sich als bearbeitbare Tabelle: Zellen kopieren und einfügen, Zeilen und Spalten hinzufügen oder entfernen, mit Ctrl+S speichern und mit Ctrl+Z und Ctrl+Y rückgängig machen oder wiederholen.

- PDF- und Office-Dateien (Word, PowerPoint, Excel) werden im Seitenbereich in der Vorschau angezeigt. Office-Seiten öffnen sich sofort erneut, und ein Link beginnt mit der Konvertierung seines Dokuments, sobald Sie mit der Maus darauf zeigen.

- Unterhaltungen lassen sich mit einem Stern markieren: Favoriten bleiben oben in der Sitzungsliste, und der Stern erscheint, wenn Sie mit der Maus über eine Zeile fahren.

- Die Suche findet Text in früheren Unterhaltungen. Eine gelöschte Unterhaltung hinterlässt keine Suchergebnisse, egal auf welchem Weg sie entfernt wurde.

- Wenn Sie nach oben scrollen, während eine Antwort gestreamt wird, bleibt Ihre Position erhalten, statt wieder nach unten zu springen.

- GitHub-Aktionen in einer Antwort werden in einer GitHub-Karte zusammengefasst, und die Schleife der Denkanzeige springt beim Neustart nicht mehr.

- Anbieterkonten zeigen ihre Anmelde-E-Mail, und beim erneuten Verbinden desselben Kontos bleiben Name und Nutzungsverlauf erhalten, statt einen neuen Eintrag anzulegen. Der Nutzungsdialog listet keine getrennten Konten mehr auf.

- Ein aus der Warteschlange zurück in den Entwurf geholter Prompt erscheint nach einem Neustart nicht mehr erneut, und beim schnellen Wiederöffnen der App bleibt die Unterhaltung bearbeitbar, statt schreibgeschützt geöffnet zu werden.

- Übersetzungskorrekturen: Falsche Beschriftungen wie Git im Italienischen, Models im Vietnamesischen und Effort im Chinesischen und Japanischen werden jetzt richtig angezeigt.

- In der Smartphone-Weboberfläche fügt Enter einen Zeilenumbruch ein, und die Senden-Schaltfläche sendet.

- Memory startet auf Windows-Profilen, deren Benutzerordnername nicht reines ASCII ist.

- Sicherheitsupdates für die Abhängigkeiten image-size und js-yaml (CVE-2025-71329, CVE-2026-84375).

## v1.0.11 - 2026-10-08

- Der integrierte Browser zeigt Seiten auf Windows-Displays mit einer Skalierung über 100 % wieder an, statt mit „Browser display did not recover after the page changed“ zu scheitern (#8). Seiten folgen außerdem Änderungen der Anzeigeskalierung, auch Tabs, die zu diesem Zeitpunkt nicht sichtbar waren.

- Word-, PowerPoint- und Excel-Dateien (.docx, .pptx, .xlsx, .xlsm) können an Nachrichten und Automatisierungen angehängt werden, und ihr Text erreicht jedes Modell. Dateitypen, die sich nicht anhängen lassen, weisen jetzt darauf hin und fügen stattdessen den Dateipfad ein; leere Dateien oder Dateien, die keine echten PDFs sind, werden mit einer klaren Meldung abgelehnt.

- PDFs und Bilder aus früheren Teilen einer Unterhaltung werden auch nach einem Neustart der App weiterhin an das Modell gesendet. Modelle ohne native PDF-Unterstützung erhalten den Text des PDFs. Beim Lesen eines PDFs mit mehr als 100 Seiten werden die ersten Seiten als Text zurückgegeben, und passwortgeschützte oder ungültige PDFs liefern einen klaren Fehler, statt spätere Anfragen zu beeinträchtigen.

- Bilder und Dateien, die MCP-Tools zurückgeben, erreichen das Modell als Bilder und Dateien statt als roher kodierter Text; nicht unterstützte oder zu große Medien werden beschrieben.

- Zusammenfassungen, die beim Komprimieren einer langen Unterhaltung entstehen, enthalten jetzt auch lange Nachrichten und vermerken angehängte Bilder und Dateien.

- Lokale Nur-Text-Modelle behalten den Text angehängter Dokumente, und frühere Bilder werden zu einem kurzen Hinweis, statt die Unterhaltung zu stoppen.

- Feedback, optional mit Screenshots, kann unter Einstellungen > Über gesendet werden, und dort lässt sich auch das Änderungsprotokoll lesen.

- Aktuelle Unterhaltungsnachrichten lassen sich unmittelbar nach dem Speichern in der Erinnerungssuche nach Bedeutung finden.

- Suchergebnisse werden nur wiederverwendet, solange sie noch aktuell sind (#7), und eine Dateilistensuche nach einer Inhaltssuche liefert Dateinamen statt des früheren Inhalts (#9).

## v1.0.10 - 2026-10-08

- Benutzerdefinierte API-Anbieter können in den Einstellungen mit anbieterspezifischen Verbindungsadaptern registriert werden.

- QR-Codes für Remote-Verbindungen erscheinen erst, wenn das Relay bereit ist, und veraltete Kopplungskarten werden entfernt.

- Fortlaufende OpenRouter-Modellaliasse können für Main und Agenten ausgewählt und gespeichert werden. Aktuelle Aliasse und stabile Modelle werden nicht mehr fälschlicherweise wegen des Katalogalters, neuerer Vorschauversionen oder der Familienlimits der Modellauswahl ausgeblendet.

- Die native Patch-Initialisierung hält ihren Prozess am Leben, solange die Verifizierung aussteht, und verhindert so ein vorzeitiges Beenden, wenn sich Vorwärmen und Verifizierung überschneiden.

## v1.0.9 - 2026-10-07

- Allgemeine und Projektanweisungen erreichen jede neue Unterhaltung auch dann, wenn die Erweiterung „Erinnerungen“ nicht installiert oder ausgeschaltet ist; dieser Schalter betrifft jetzt nur noch die Erinnerungs- und Recall-Tools. Das Speichern einer Anweisung wartet nicht mehr mehrere Sekunden auf das Embedding-Modell, Anweisungen werden wie geschrieben und ohne interne IDs übernommen, und sie dürfen insgesamt bis zu 32 KB umfassen.

- Die Anmeldung bei GitHub über die Einstellungen und jede andere Funktion, die einen Terminalprozess startet, funktionieren in der installierten Desktop-App wieder, statt mit „posix_spawnp failed“ zu scheitern. Ein veraltetes zusätzliches GitHub-Konto, das von gh gespeichert wurde, führt bei einer erfolgreichen Anmeldung nicht mehr zur Meldung „no account is signed in“.

- Browser Use und Computer Use fragen vor ihrem ersten Aufruf in einer Sitzung nicht mehr nach einer Genehmigung, und `setup set_first_use_approval` entfällt.

- Die Tool-Genehmigungskarte entspricht den Karten oberhalb der Eingabe: Warnsymbol, Titel und Tool stehen in einer Zeile, der Grund steht darunter und nennt nur den zu genehmigenden Befehl, Pfad oder die URL (keine Ordnerzeile und keine Argumentenliste), und „Ablehnen“ steht dezent neben „Zulassen“.

- Neue Modelle übernehmen ihre Fähigkeiten aus den Anbieterkatalogen, statt auf einen Release zu warten: Änderungen des Aufwands mitten in der Unterhaltung über die ChatGPT-Route, Fast mode und Cache-Einstellungen über die OpenAI-API-Route, Fast mode bei Claude und Reasoning-Aufwand bei xAI. GPT-6.1 Sol und Claude Sonnet 5.5 werden jetzt unterstützt, und der Fast-Schalter erscheint nicht mehr bei Claude-Modellen, die ihn nicht nutzen können.

- Claude Sonnet 5.5 zeigt seine Notizen zwischen Tool-Aufrufen wieder an, und Claude-Fable- und Mythos-Modelle können die gehostete Websuche nutzen.

- Die vom jeweiligen Anbieter erwartete Client-Version wird zwischen den Starts gespeichert, sodass ein Neustart oder ein Offline-Start nicht mehr auf einen alten eingebauten Wert zurückfällt.

- Weitere „Unterhaltung zu lang“-Fehler von GLM, Kimi, Qwen, MiniMax, xAI und anderen Backends lösen jetzt eine Komprimierung aus, statt den Durchlauf zu beenden, und eine Claude-Überlastung mitten in einer Antwort folgt denselben Wiederholungs- und Fallback-Regeln wie eine zu Beginn einer Antwort.

- Hinweise und Fehler stapeln sich nicht mehr über der Eingabe: Bestätigungen von Slash-Befehlen sowie Fehler bei Mikrofon, Anhängen und Befehlen erscheinen als Benachrichtigungen, und der Fortschritt von Sprach-Downloads wird nur auf der zugehörigen Einstellungskarte angezeigt. Jeder Fehler wird jetzt einheitlich ohne umrandete Karte dargestellt, und Downloads lokaler Modelle zeigen unter ihrer Zeile einen Fortschrittsbalken in voller Breite.

## v1.0.8 - 2026-10-05

- Die macOS-App ist mit einem Developer-ID-Zertifikat signiert und von Apple notarisiert, sodass eine heruntergeladene Kopie ohne Gatekeeper-Warnung geöffnet wird und die macOS-Autoaktualisierung neue Versionen installieren kann. Die Abfragen für Mikrofon und AppleScript erklären jetzt, wofür Mixdog sie verwendet.

## v1.0.7 - 2026-10-04

- Browser Use auf dem Smartphone streamt die Desktop-Seite live, statt Schnappschüsse zu aktualisieren, und akzeptiert dieselben Maus-, Touch-, Rad-, Tastatur- und IME-Eingaben wie der Desktop-Bereich. Wenn ein Agent die Seite übergibt (zum Beispiel bei einem CAPTCHA), öffnet sie sich auch auf dem Smartphone.

- Die Tool-Aktivität im Transkript ist leichter zu überblicken: Jede Zeile beginnt mit einem kurzen Verb, Lese- und Suchvorgänge zeigen Ergebnisse pro Datei, Auflistungen zeigen Dateizeilen, Befehle stehen in einem eigenen Feld, die Ausgabe von `git diff` wird als Diff dargestellt, und für eine vom Browser besuchte Seite gibt es eine Karte, die sie im Bereich wieder öffnet.

- Benachrichtigungen über abgeschlossene Durchläufe kommen früher an, zeigen einfachen Text statt rohem Markdown, enden mit einem vollständigen Satz und werden nicht mehr durch lang laufende Shell-Hintergrundjobs zurückgehalten.

- Zuletzt verwendete Sitzungen öffnen sich nach einem Neustart und bei erneutem Aufruf schneller.

- Das Setup-Tool kann OAuth-Konten, Entwickleroptionen, Anheftungen der Aktivitätsleiste und den MCP-Server eines Plugins verwalten, und Anfragen aus Sitzungen in geteilten Bereichen werden verarbeitet. Das eigene Auto-Clear-Zeitfenster eines Anbieters hat jetzt Vorrang vor dem globalen.

- Das Git-Tool wird überall aktiviert, wo `git` installiert ist, ohne dass eine Erweiterung installiert werden muss. Zeitpläne und Webhooks stellen immer an die App-Sitzung zu.

- Die App-Oberfläche bleibt bei 100 % Skalierung, in einem anderen Fenster oder Terminal gespeicherte Einstellungen gelten sofort, und Rahmen, Symbole, Listenabstände und Dialogeinblendungen sind einheitlicher.

## v1.0.6 - 2026-10-03

- Push-Benachrichtigungen auf dem Smartphone bleiben stumm, solange die App auf dem Bildschirm ist, folgen einem Abonnement, das der Browser selbstständig erneuert, und der Schalter wird ausgeschaltet, wenn Benachrichtigungen in den Systemeinstellungen blockiert sind.

- Die Smartphone-App bleibt nach einem Relay-Update nicht mehr auf dem Ladebildschirm hängen, wenn sie zurückkehrt; sie lädt fertig, sobald sich der Desktop wieder verbindet, und ein schneller erster Start überspringt die Installation des Service Workers der App nicht mehr.

- Unter Android schließt die Zurück-Geste das geöffnete Panel oder Menü, ohne dass die Navigationsleiste aufblitzt.

- Workspace-Tabs, die Kopfzeile des Seitenpanels und die Studio-Bereinigungsschaltfläche sind kompakter, und der ausgewählte Tab hebt sich deutlicher ab.

- Nutzungsbeschriftungen sind kürzer, das zurückzusetzende Kontingent wird stundenweise angegeben, sobald weniger als ein Tag übrig ist, und übersteigt nie den Rest; zudem wurden Übersetzungen in allen Sprachen überarbeitet.

## v1.0.5 - 2026-10-03

- Die Desktop-App kann eine Betriebssystem-Benachrichtigung mit Ton auslösen, wenn ein Durchlauf mit seiner endgültigen Antwort endet, und die Benachrichtigung führt zurück zu dieser Sitzung.

- Die Office-Tools erstellen docx-, xlsx- und pdf-Dokumente aus HTML über eine gemeinsame Browsersitzung.

- Die Nutzung zeigt Schätzungen des Kontingentwerts und Summen pro Sitzung.

- Die Hosts für Browser und Computer Use sind robuster: Frame-Transformationen, visueller Datenschutz, gekachelte Screenshots und Wiederherstellung nach Fehlern.

- Die PowerShell-Syntaxprüfung hält Fragmente aus Verb und Bindestrich in Pfaden nicht mehr für Cmdlets.

- `adm-zip` wird wegen CVE-2026-102282 auf 0.6.1 aktualisiert.

## v1.0.4 - 2026-10-01

- Modellauswahlen werden aktualisiert, sobald sich ein Anbieter ändert. Browserbasierte OAuth-Anmeldungen (OpenAI, Grok, Cursor, Antigravity) und Kontowechsel laden die Auswahl jetzt sofort statt erst nach einem Neustart neu, und ein in einem Fenster verbundener, entfernter oder gewechselter Anbieter aktualisiert auch jedes andere Desktop-Fenster und jedes gekoppelte Smartphone.

- Das Schließen des Fensters fragt nicht mehr nach. Die Einstellungen bieten unter „Beim Schließen des Fensters“ die Wahl zwischen „Im Infobereich ausblenden“ (Standard) und vollständigem Beenden, das Tray-Symbol ist ab dem Start verfügbar, und die Beenden-Bestätigung in der App entfällt.

- Zeilen von Workflow-Agenten sehen überall gleich aus: Eine Zeile ohne festgelegtes Modell, auch Websuche, zeigt „Standard“, und Agentennamen und Modellbezeichnungen bleiben unübersetzt. Nicht ausgewählte Workspace-Tabs liegen auf einer blassen Fläche statt zwischen dünnen Trennlinien.

- Das Goal-Tool und der Skill goal-management beschreiben Ziele als Aufgabenliste für genehmigte Arbeit über mehrere Durchläufe hinweg und schließen wiederkehrende Zeitpläne sowie Vorhaben aus, die wochenlang auf externe Ereignisse warten.

## v1.0.3 - 2026-10-01

- Die Mediengenerierung erfasst pro Bild- oder Videoauftrag eine Nutzungszeile mit den vom Anbieter gemeldeten Tokens, Bildern, Sekunden und Kosten, sodass Medien von Gemini, Antigravity, Codex und xAI neben Textmodellen in den Nutzungs- und Kostensummen erscheinen. Die Medienpreise stammen aus dem veröffentlichten Preiskatalog.

- Stopp und Fortsetzen bei Computer Use erholen sich sauber nach einer fehlgeschlagenen Bereinigung: Inaktive Worker werden stillgelegt, statt in ein Timeout zu laufen, und ein Stopp oder Fortsetzen durch den Nutzer löscht den veralteten Zustand „input not confirmed released“.

- Sitzungen, die auf Shell-Hintergrundjobs warten, werden als wartend statt als inaktiv angezeigt, und die Anzeige der Shell-Jobs zeigt nicht mehr die Jobs eines früheren Besitzers und verliert keine Aktualisierungen, die während einer Abfrage eintreffen. Sitzungs- und Agentenlisten überspringen überflüssige Neuzeichnungen, wenn sich nichts geändert hat. Das Nutzungsdiagramm, die Rail-Seiten, Workspace-Tabs, Erweiterungslisten und Dialoge haben ein überarbeitetes Erscheinungsbild.

- Identische gleichzeitige grep- und read-Scans teilen sich einen nativen Scan, zwischengespeicherte Ergebnisse werden nach Änderungen pro Pfad ungültig gemacht, und ein abgebrochener Patch hört auf, bevor weitere Dateien geschrieben werden. Die Code-Graph-Suche erkennt Windows-Pfade unabhängig von Groß-/Kleinschreibung, Trennzeichen sowie Verbatim-Präfixen (`\\?\`) und UNC-Präfixen. Ein fehlschlagender Pre-Tool-Hook blockiert das Tool jetzt, statt es laufen zu lassen.

- Der Browser-Skill lässt Seiten im Hintergrund, es sei denn, die Seite selbst ist das Ergebnis oder der Nutzer muss darauf handeln. Die Desktop-Entwicklung (`npm run dev`) und die direkten Windows-E2E-Skripte laufen in einem frischen, isolierten Profil auf dem CDP-Port `9342`.

## v1.0.2 - 2026-10-01

- Kopierschaltflächen im Transkript können aus dem vertrauenswürdigen Desktop-Fenster in die Zwischenablage schreiben. Antworttext, Codeblöcke, Tool-Ausgaben und Diffs pro Datei haben Regressionsabdeckung für exakt kopierten Text, Wiederholungen und sich ändernde Inhalte; Lesezugriffe auf die Zwischenablage und Berechtigungen für andere Fenster bleiben blockiert.

- Die Befehle für Modell und Aufwand öffnen die Modellauswahl der aktuellen Unterhaltung, und deaktivierte Agenten behalten das für sie ausgewählte Modell. Das Einführungs-Tutorial erklärt die Modellempfehlung für den Maintainer, und die Diagnose deckt jetzt lokale Anbieter, eingebaute Funktionen, Sprache sowie fehlende oder ungültige Plugins ab.

- Windows-Dateilinks verarbeiten kodierte Trennzeichen und Pfade mit Leerzeichen oder koreanischem Text. Eine Dateierwähnung, deren erste Suche fehlgeschlagen ist, kann angeklickt werden, um es erneut zu versuchen. „Alle auswählen“ in Studio umfasst alle Elemente des Tabs, nicht nur die bereits geladenen Seiten.

- Computer Use hält Aufnahmereferenzen im Einklang mit erneuten Lesevorgängen der Barrierefreiheit, bindet neu aufgebaute Steuerelemente nur dann sicher neu, wenn ihre beobachtete Identität übereinstimmt, und wartet, solange der Eingabe-Desktop gesperrt ist, statt die Sperre als Beobachterfehler zu werten.

- Workspace-Tabs und das Einführungs-Tutorial haben ein klareres Erscheinungsbild, die Sitzungsseitenleiste ist beim Start geöffnet, und Tool-Gruppen zeigen das gesammelte Fehlerabzeichen nicht mehr an. Der Text der Projektanweisungen wird nicht mehr in den Umgebungsblock des System-Prompts aufgenommen. Veröffentlichte Pakete schließen verschachtelte Entwicklungstests aus.

## v1.0.1 - 2026-09-30

- Die Desktop-App unter Windows 11 sitzt jetzt in einem Mica-Fensterrahmen mit einer ruhigeren, monochromen Oberfläche: Popups und Panels trennen sich durch Schatten statt durch Rahmen, Auswahlen werden nicht mehr blau, und die Akzentfarbe ist dem Live-Zustand vorbehalten. Der Text folgt einer einheitlichen Schriftskala (12px-Beschriftungen bis zu 20px-Seitentiteln und Kennzahlen), der ausgewählte Tab ist eine erhabene Karte, destruktive Schaltflächen bleiben neutral, bis man sie überfährt, und die Nutzungs- und Kontextdiagramme teilen sich eine Palette.

- Beim Schließen des Fensters wird einmal gefragt, ob Mixdog im Infobereich weiterlaufen oder vollständig beendet werden soll, und die Antwort wird gespeichert. Beim Beenden, während ein Agent noch arbeitet, wird jedes Mal gefragt.

- Die Abonnementnutzung zeigt den Anteil jedes Modells als gestapelte Fläche unter der Gesamtlinie, und ihre Hover-Karte folgt dem Zeiger nur innerhalb des Diagramms.

- Die Unterhaltung bleibt an ihrer neuesten Nachricht haften, wenn eine Karte während des Scrollens ihre Höhe ändert. SVG-Dateien, die ein Agent schreibt, erscheinen als Bildergebnisse und öffnen sich im System-Viewer, und Agenten übergeben visuelle Arbeit wie SVGs oder HTML-Seiten als gespeicherte Dateien, statt ihren Quelltext einzufügen.

## v1.0.0 - 2026-09-30

- Erinnerungen können nicht mehr durch einen Neuaufbau der Runtime lahmgelegt werden. Eine neu aufgebaute Memory-Runtime wird unter einem neuen Release-Tag veröffentlicht, statt Dateien zu ersetzen, die installierte Apps prüfen; eine neue Runtime wird neben der verwendeten installiert, statt sie zu löschen, während PostgreSQL noch daraus läuft, und zwei gleichzeitig installierende Prozesse löschen nicht mehr gegenseitig ihren Download. Lokale Entwicklungs-Deploys verweigern die Ausführung von einem Branch, der hinter seinem Upstream liegt.

- Tool-Karten markieren abgeschlossene Aufrufe nicht mehr als fehlgeschlagen. Ein Befehl, dessen Ausgabe eine `status:`-Zeile enthält, ein `git diff --quiet` oder `git grep`, das einen Unterschied oder keinen Treffer meldet, eine code_graph-Abfrage ohne gefundenes Symbol und das Blättern in gespeicherten tidy-Ergebnissen gelten jetzt als abgeschlossen; ein Git-Befehl mit Exit-Code ungleich null wird wie bei der Shell als Exit angezeigt, und ein Browser- oder Computer-Befehl, der gestoppt wurde, weil der Nutzer die Kontrolle übernommen hat, wird als abgebrochen angezeigt.

- Weniger Tool-Aufrufe scheitern an einem Argumentfehler im ersten Versuch: Das Git-Tool ergänzt ein fehlendes führendes `git`, read gibt sein Limit von 10 Zielen in seinem Schema an, und ein Goal voller erledigter Aufgaben sagt, wie sich Platz für neue schaffen lässt. Fehlerprotokolle erfassen jetzt die Leseziele und die volle Größe von Pfadstapeln.

- Anfragen werden mit der Preisstufe abgerechnet, mit der sie tatsächlich gesendet wurden: Fast- und Priority-Anfragen verwenden ihre veröffentlichten Preise, eine als Standard wiederholte Fast-Anfrage wird als Standard abgerechnet, und Cursor-Fast-Varianten werden als ihr Katalogmodell abgerechnet. Das Umschalten von Fast aktualisiert die Statuszeile sofort.

- Regeln zur Excel-Datenüberprüfung werden geprüft, bevor eine Arbeitsmappe erstellt wird, sodass ein unbekannter Regeltyp oder eine fehlende Grenze auf beiden Backends sofort fehlschlägt. Der Glanzeffekt der Live-Aktivität ist ein kürzeres, blasseres Band, und Namen in Tool-Zusammenfassungen verwenden die mittlere Schriftstärke.

## v0.9.175 - 2026-09-29

- Claude-Agenten behalten ihren Konversations-Cache jetzt 5 Minuten statt einer Stunde. Kommt die nächste Anfrage eines Agenten, nachdem dieser Cache abgelaufen ist – nach einem langen Build oder Test oder wenn ein fertiger Agent wieder aufgegriffen wird –, komprimiert er zuerst seine Unterhaltung, sodass die Anfrage die komprimierte Unterhaltung neu schreibt statt alles, was der Agent angesammelt hatte. In einer Wiederholung der jüngsten Claude-Agentennutzung senkte das die Token-Kosten der Agenten um etwa ein Viertel. Lead-Sitzungen bleiben unverändert.

- Viele parallel laufende Sitzungen bremsen sich nicht mehr gegenseitig aus. Ausstehende Nachrichten werden pro Sitzung geführt, Sitzungszusammenfassungen und Gateway-Nutzung werden angehängt statt neu geschrieben, gespeicherte Transkripte werden außerhalb der Hauptschleife geparst, und ein fehlschlagender Memory-Zyklus zieht sich zurück, statt in einer engen Schleife zu wiederholen. Beim Beenden des Daemons wird der Grund festgehalten. Der separate Multi-Prozess-Sitzungshost entfällt; Sitzungen laufen im Daemon selbst.

- Die vor einem Kontowechsel erfasste Abonnementnutzung wird dem Konto zugerechnet, das bei Beginn der Erfassung verwendet wurde. Grok, Claude und Cursor melden ihre aktuellen Client-Versionen statt fester.

- Die Desktop-App zeigt keine leere Sitzung mehr an, wenn der Daemon ihren Inhalt kurz nach der Antwort auf die Öffnungsanfrage liefert. Das Boot-Skript der gepackten App wird von der Content Security Policy zugelassen, und Projektwurzelprüfungen, Relay-Dispatch-Fehler und die Wiederherstellung von Browsersitzungen wurden korrigiert.

- Ohne Office bearbeitete Arbeitsmappen und Dokumente: Das Leeren einer leeren Zelle löscht nicht mehr die darauffolgende Zelle, das Löschen eines Kommentars findet Kommentare mit Autorenformatierung, über absolute Pfade verknüpfte Teile werden aufgelöst, und Text, der wie ein Ersetzungsmuster aussieht, wird wörtlich eingefügt.

- Heruntergeladene Runtimes (PostgreSQL, pgvector, Schriftarten, FFmpeg) werden vor der Verwendung anhand festgelegter Prüfsummen geprüft. Native Tools beheben einen Fehler beim Parsen von Fenster-IDs, der ein Multibyte-Zeichen teilen konnte, eine Zeitberechnung, die überlaufen konnte, und einen Snapshot-Austausch, der eine unvollständige Datei hinterlassen konnte.

## v0.9.174 - 2026-09-29

- Der Nutzungsdialog beantwortet jetzt eine zweite Frage: wie das Kontingent eines Abonnements aufgebraucht wurde. Neben der Token-Nutzung verfolgt ein Tab „Subscription usage“ die eigenen Limitfenster jedes Anbieters – Codex, Claude, Grok, Cursor, Antigravity und OpenCode Go – beim Ansteigen und Zurücksetzen, mit den Modellen, die den Zähler bewegt haben, und dem Verlauf früherer Fenster. Mixdog zeichnet jede gemessene Kontingentablesung auf; ein Anstieg ohne zugehörige Mixdog-Anfrage wird als Nutzung außerhalb von Mixdog angezeigt, etwa über die Web-App des Anbieters. Ein Anbieterzähler im Nutzungs-Flyout öffnet direkt das zugehörige Abonnement.

- `/doctor` funktioniert auch in der Desktop-App als Dialog (auch unter Einstellungen → System → Doctor). Er führt dieselben schreibgeschützten Gesundheitsprüfungen wie die TUI aus, alle auf einmal und mit einer Frist pro Prüfung, damit eine hängende Prüfung die anderen nicht verdeckt, und jede Warnung oder jeder Fehler sagt, wie er zu beheben ist.

- Neue PowerPoint-Präsentationen werden in HTML gestaltet. Das Modell legt jede Folie in HTML und CSS an, ein lokales Chrome oder Edge rendert sie, und `author` wandelt das vom Browser Gezeichnete in native, bearbeitbare PowerPoint-Objekte um: Textfelder, die die Zeilenumbrüche des Browsers beibehalten, Formen, Linien, Tabellen, Diagramme und Bilder. Koreanischer Text bricht dort um, wo ein Leser es erwartet, eine Geometrieprüfung weist Folien zurück, deren deklarierte Ausrichtungen der Browser nicht bestätigen kann, und `render` zeigt jede HTML-Seite neben ihrem PowerPoint-Rendering. Der Skript-Weg bleibt für Präsentationen, die die gemessenen Elemente des Kits wollen, oder wenn kein lokaler Browser vorhanden ist.

- Das Einfügen oder Löschen von Zeilen und Spalten in einer Arbeitsmappe ohne Excel schreibt jetzt alles um, was diese Zellen benennt, wie Excel es tut: Formeln auf allen Blättern, definierte Namen und Druckbereiche, bedingte Formate, Validierungen, Diagrammreihen, Pivot-Quellen, Filter, Verknüpfungen, Zellverbunde, Tabellen und Zeichnungen. Bisher verschoben sich die Zellen, während ihre Verweise blieben, sodass eine Berichtssumme weiter den alten Bereich addierte und 72.200 anzeigte, wo Excel 74.700 anzeigte. Eine Bearbeitung, deren Verweise sich nicht umschreiben lassen, wird mit der Liste abgelehnt, bevor sich etwas ändert.

- PDFs und zusammengesetzte Tabellenbänder halten koreanische Datumsangaben, Uhrzeiten, Brüche und Beträge in einer Zeile. „10월 14일“, „14시 30분“, „3분의 1“, „12만 6천 원“ und „24억 원“ brechen nicht mehr mitten im Ausdruck um, was ein Entscheidungsdatum oder eine Einsparung auf zwei Zeilen verteilt hatte.

- Office-Dateien sehen gleich aus, egal ob Microsoft Office oder der eingebaute portable Writer sie erzeugt hat. Ein langer direkter Vergleich beider glich an: bei Word Abstände, Kompatibilitätsmodus und Tabellen; bei Excel Autofit, Einzüge, Rahmen, Druckeinrichtung und voreingestellte Diagramme; bei PowerPoint koreanischen Umbruch, ostasiatische Schriftarten, Fußzeilen, Titelbeschnitte, Schatten und Transparenz; sowie bei PDF Ausrichtung und Tabellenbreiten. Prüfungen melden auf beiden Backends dieselben Probleme, Excel-Diagramme können den Bereich eines anderen Blatts lesen, und `set_chart_data` behält die Verknüpfungen und Reihennamen eines Diagramms.

- Computer Use läuft unter macOS und Linux. Desktop-Builds für diese Systeme enthalten ein natives Backend, das das Protokoll des Windows-Hosts spricht und dieselben Aktionslisten und Limits durchsetzt. Eine Sequenz kann nun auch auf mehrere Elemente einer Beobachtung wirken: Jeder spätere Schritt weist sein Element erneut am Live-Barrierefreiheitsbaum nach, und die Kette stoppt bei einem Fensterwechsel, einem Fehler oder einem deaktivierten oder außerhalb des Bildschirms liegenden Element.

- Die Smartphone-App öffnet und verbindet sich schneller neu und überträgt weit weniger Daten. Das Transkript erscheint direkt nach der ersten Synchronisierung, kurze Wiederverbindungen setzen als Deltas statt mit einer vollständigen Neusynchronisierung fort, das Smartphone spiegelt nur den Tab, den es anzeigt, die eingeklappte Durchlaufprüfung liest Dateinamen und Anzahlen ohne Patch-Text, und langsame Projektsuchen halten andere Aufrufe nicht mehr auf. Eine geöffnet gehaltene Smartphone-App prüft bei der Rückkehr in den Vordergrund auf einen neuen Deploy und übernimmt ihn im Hintergrund, auch mitten in einem Durchlauf.

- Der Daemon braucht weniger Speicher und stockt weniger: Sitzungen speichern nur Geändertes, das Nutzungsbuch arbeitet außerhalb des Hauptthreads, Dateisperren und Git-Aufrufe blockieren ihn nicht mehr, und lange Transkripte werden in 1-MB-Schritten nachgeladen. Desktop und Smartphone rendern gestreamtes Markdown und Touch-Scrolling mit weniger Layouts, und das Transkript der Web-App ruckelt nicht mehr, während Zeilen vermessen werden.

- Die Spracheingabe zeigt an, dass sie sich vorbereitet, bis die Aufnahme wirklich beginnt, wärmt die Transkription schon während des Sprechens auf und transkribiert schneller, ohne die App zu blockieren.

- Tool-Ergebnisse kosten das Modell weniger Tokens. `read` liefert seine Zeilen ohne Zeilennummern – die TUI und der Desktop zeichnen den Seitenstreifen weiterhin –, was bei aufgezeichneten Sitzungen etwa 16 % weniger Tokens bedeutet; Shell- und Task-Hinweise sind kürzer; und Bearbeitungen melden Pfade relativ zum Arbeitsverzeichnis.

- Die Komprimierung trägt in großen Kontextfenstern weniger veraltetes Material mit. Die wörtliche Unterhaltung und der jüngste Tool-Verlauf, die bei einer Komprimierung erhalten bleiben, sind auf 20.000 Tokens begrenzt, statt mit dem Fenster zu wachsen. Ein Browser-Snapshot oder eine Desktop-Beobachtung, die durch eine spätere derselben Seite oder desselben Fensters ersetzt wurde, behält nur ihr Ergebnis und einen Verweis auf das archivierte Original, und ältere Antworten verwerfen ihr undurchsichtiges Anbieter-Replay, behalten aber ihre Tool-Aufrufe und -Ergebnisse.

- Ein kurzzeitig nicht verfügbarer Anbieter beendet den Durchlauf nicht mehr in dem Moment, in dem seine eigenen Wiederholungsversuche ausgehen. Solange noch nichts auf dem Bildschirm erschienen ist, wartet der Durchlauf einige weitere Erholungszyklen von 15 Sekunden bis zu einer Minute ab und folgt dem eigenen Retry-After eines Servers. Wird ein Stream unterbrochen, während die Argumente eines Tool-Aufrufs noch eintreffen, wird dieser Aufruf nicht ausgeführt, und das Modell erhält den Hinweis, den Inhalt auf kleinere Aufrufe aufzuteilen, statt ihn komplett erneut zu senden.

- OAuth für Cursor und Antigravity (Gemini) sind getrennte Schalter unter Einstellungen → Developer, und jeder wird erst aktiv, nachdem Sie das Risiko von Kontoeinschränkungen bestätigt haben, das mit der Nutzung dieses Anbieters über OAuth einhergeht. Die Umgebungsvariable `MIXDOG_DEV_PROVIDERS` schaltet sie nicht mehr ein.

- Die Unterhaltung springt nicht mehr, wenn sich die Leisten über dem Eingabefeld öffnen oder schließen: Sie gleiten über die Bewegung, statt das Transkript auf einmal um ihre volle Höhe zu verschieben, und beim Öffnen einer Sitzung blitzt keine Anzahl der Durchlaufprüfung mehr auf, die einen Moment später wieder verschwindet.

- Das Umbenennen einer Datei oder eines Ordners im Explorer hält die geöffneten Editor-Tabs auf dem neuen Pfad. Eine Datei mit ungespeicherten Änderungen wird abgelehnt, bis sie gespeichert ist, da ihr Puffer zum alten Pfad gehört.

- Studio räumt in großen Mengen auf: die ausgewählten Elemente, alles vor einem Datum, Einträge, deren Dateien fehlen, oder alles einer Art. Unter Einstellungen → Über steht eine Support-Adresse mit den Schaltflächen „Kopieren“ und E-Mail, und der Dialog „Clear browsing data“ des integrierten Browsers wurde entfernt.

- Ein automatischer Goal-Durchlauf, der kein Tool aufruft, wartet jetzt, statt erneut aufzufordern.

## v0.9.173 - 2026-09-22

- Eine wiederhergestellte Nachricht in der Warteschlange behält den Text, den der Daemon bestätigt hat. Das Wiederherstellen veröffentlicht zweimal in einem Atemzug – zuerst die lokale Vermutung, einen Moment später die Antwort des Daemons –, und beide wurden mit der Uhrzeit gestempelt. Landeten sie in derselben Millisekunde, hielt der Prompt die zweite für die erste und behielt die Vermutung, sodass eine bearbeitete Nachricht subtil falsch zurückkommen konnte. Der Prompt folgt jetzt dem Text selbst, nicht nur dem Zeitstempel.

- Zwei Sprünge im selben Augenblick verlieren den zweiten Sprung nicht mehr. Zwei „Gehe zu dieser Zeile“-Anfragen innerhalb derselben Millisekunde trugen denselben Zeitstempel, und der Editor las nur den Zeitstempel, sodass die zweite verworfen wurde und der Cursor in der ersten Zeile stand.

- Eine Suche, die abstürzt, reißt nicht mehr die ganze Suchmaschine mit. Die Engine konnte bereits eine fehlerhafte Anfrage mit einem Fehler beantworten und weiterlaufen, aber der ausgelieferte Build war so kompiliert, dass jeder Absturz den Prozess beendete – wodurch jede andere laufende Suche und der warme Dateiindex verloren gingen. Jetzt überlebt sie, beantwortet diese eine Anfrage mit einem Fehler und behält ihre Caches. Tritt ein Absturz auf, während Dateien gesammelt werden, werden die bereits gesammelten Pfade trotzdem veröffentlicht, statt stillschweigend aus der Antwort zu verschwinden.

- „Anwenden“ und „Löschen“ in der Zeile eines lokalen Anbieters stehen in derselben Zeile. Sie unterschieden sich um zwei Pixel, weil die Zeile ein höheres Eingabefeld mit einer niedrigeren Schaltfläche mischte.

- Beim Aufräumen von Code erfahren Sie, wenn ein Tool nicht das Tool ist, für das Sie es halten. Ist auf Ihrem Rechner ein gleichnamiger Formatter oder Linter erreichbar, der nicht der von Mixdog ausgeführte ist, nennt der Bericht jetzt beide mit Versionen – die Ausführung der anderen Binärdatei sagt nichts über das Ergebnis aus, das Ihnen gezeigt wurde. Ein Aufräumlauf trennt außerdem Befunde in Dateien, die Sie bereits angefasst haben, von Befunden in Dateien, die im Repository unberührt sind, sodass das Anwenden von Korrekturen auf ein ganzes Verzeichnis keine Dateien mehr umschreibt, die Sie nie ändern wollten.

- Das Aktualisieren Ihrer installierten App bricht nicht mehr ab, weil Ihr Virenschutz eine Datei entfernt hat, die das Update ohnehin verwirft. Das Staging entpackte die gesamte installierte App und löschte den Teil, den es ersetzen wollte; ein einziges in Quarantäne verschobenes Renderer-Asset genügte, um den Deploy abzubrechen.

## v0.9.172 - 2026-09-21

- Eine Seite meldet beim Öffnen keine Downloads mehr, die sie nie gestartet hat. Gespeicherte Dateien gehören zur Sitzung, aber jede Seite verfolgte ab null, was sie als gestartet gemeldet hatte, sodass jede später geöffnete Seite den Aufrufer mit dem gesamten Rückstand begrüßte – etwa eine Suchseite, die eine Datei meldete, die ein anderer Tab Minuten zuvor gespeichert hatte. Eine neue Seite weiß von Anfang an, was vor ihrer Existenz geschah; eine Datei, die gespeichert wird, während sie geöffnet ist, erreicht sie weiterhin.

- Eigene Fehler des Browsers gelten nicht mehr als Fehler der Seite. Ein CDP-Aufruf mit Zeitüberschreitung, ein Child-Frame, der nicht angehängt werden konnte, eine Interception, die nicht beantwortet werden konnte – alles wurde als Konsolenfehler der Seite protokolliert, sodass eine Antwort über eine gesunde Website mit `CDP Runtime.evaluate timed out` beginnen konnte, als hätte die Website das protokolliert. Sie bleiben über `console` lesbar, mit `[browser]` markiert, und zählen nicht mehr zu den Fehlern, für die eine Seite verantwortlich ist.

- Eine hinter einem offenen Dialog erreichte Frist sagt das auch. Ein Alert, Confirm oder Prompt friert den Haupt-Thread der Seite ein, sodass der nächste Aufruf mit nichts als der Frist an seiner Zeitüberschreitung starb – und der naheliegende neue Versuch genauso. Der Fehler nennt jetzt den Dialog und seinen Text und sagt, dass er mit `handle_dialog` zu beantworten ist, bevor wieder auf der Seite gehandelt wird.

- Ein clientseitiger Routenwechsel wird mit dem Bildschirm beantwortet, den er erzeugt hat, nicht mit dem, den der Aufrufer verlassen hat. Single-Page-Apps ändern die Adresse mit `history.pushState` und rendern die neue Ansicht einen Moment später; es wird kein Dokument geladen, sodass die Beruhigungsprüfung eine ruhige Seite sah und sofort zurückkehrte – und ein `expect.url` wurde durch die neue Adresse erfüllt, bevor etwas gezeichnet war. Ein Klick auf „Learn“ auf react.dev wurde mit der Startseite unter der Adresse `/learn` beantwortet. Ändert eine Aktion die Adresse ohne Ladevorgang, wartet die Antwort jetzt, bis die Seite ruhig ist, und eine URL-Bedingung darf das nicht abkürzen. Gemessen am Real-Device-Harness: Die Latenzen von navigate, click und snapshot sind unverändert, weil nur Routenwechsel innerhalb desselben Dokuments die zusätzliche Wartezeit erhalten.

- Ein WebSocket-Detail zeigt die tatsächlich gesendete Upgrade-Anfrage. Nur die Adresse und die Handshake-Antwort wurden aufgezeichnet, sodass `network` mit einem leeren Abschnitt der Anfrage-Header antwortete – und ein abgelehntes Upgrade lässt sich meist durch `Origin`, `Sec-WebSocket-Protocol` oder ein Cookie erklären. Zugangsdaten bleiben geschwärzt.

- Ein Klick, der einen Tab öffnet, wird nicht mehr als wirkungsloser Klick gemeldet. Ein Link mit `target="_blank"` lässt das aktuelle Dokument unberührt, sodass die Antwort „No observable change“ lautete und den Aufrufer anwies, nach einem verdeckenden Element zu suchen – während die soeben geöffnete Seite unerwähnt in `list_tabs` stand. Die Antwort nennt jetzt die geöffnete Seite und wie man darauf handelt.

- `drag` akzeptiert snapshotfreie Ziele wie jede andere Zeigeraktion. Seine beiden Enden akzeptierten nur Refs oder rohe Koordinaten, und die Elemente, die eine Seite ziehbar macht – Karten, Listenzeilen, Ablagezonen –, tragen oft keinen zugänglichen Namen und damit keinen Ref, sodass das Verschieben eines Elements erst einen visuellen Snapshot erforderte, selbst wenn der CSS-Selektor bekannt war. `target` und `dropTarget` benennen jetzt die beiden Enden und werden gemeinsam in einer Beobachtung aufgelöst; Refs und Koordinaten funktionieren wie bisher, und beide Enden müssen weiterhin auf dieselbe Weise adressiert werden.

- Eine gespeicherte Datei wird nicht mehr als fehlgeschlagene Anfrage gemeldet. Eine Adresse, die zu einem Download wird, bricht ihre eigene Navigation ab, und Chromium meldet diesen Abbruch als `net::ERR_ABORTED`, sodass eine Antwort, die den Download aufführte, ihn auch als jüngsten Netzwerkfehler aufführte. Abgebrochene Anfragen – Downloads, von der Seite verworfene Fetches, durch eine andere ersetzte Navigationen – bleiben über `network` lesbar, werden aber nicht mehr ungefragt als Fehler der Seite gemeldet; eine tatsächlich fehlgeschlagene Anfrage weiterhin schon.

- Eine `brief`-Antwort macht aus einem ausgefüllten Feld nicht mehr eine seitenweite Änderung. Sie vergleicht mit der vorherigen Beobachtung des Aufrufers, und wenn diese begrenzt oder gefiltert war, hatte sie den Rest der Seite nie gemeldet – sodass jedes Element außerhalb als „changed or new“ aufgeführt wurde. Das Ausfüllen dreier Felder in einem Formular wurde mit fünfzehn Elementen beantwortet, die Eingabe eines Suchworts mit hundertsechsundvierzig. Die Antwort trennt jetzt, was die Aktion nachweislich geändert hat, von dem, was die frühere Beobachtung schlicht nie abdeckte, und sagt, wie viel von der Seite diese Beobachtung enthielt. Ausgelassen wird in beiden Fällen nichts.

- Anfrage-Header in `network` sind die tatsächlich gesendeten. Chromium meldet zuerst einen vorläufigen Satz und fügt Sprache, Kodierung, Client Hints und Cookies danach hinzu, sodass ein Anfragedetail zwei Header zeigen konnte und aussah, als hätte die Seite nie koreanische Inhalte angefragt. Der spätere Satz wird zusammengeführt; Zugangsdaten werden weiterhin benannt und nie angezeigt. Header-Namen sind nicht von der Groß-/Kleinschreibung abhängig, und die beiden Berichte schreiben sie unterschiedlich, deshalb behält die Zusammenführung pro Header einen Eintrag – die Schreibweise und den Wert, die tatsächlich übertragen wurden –, statt `User-Agent` und `user-agent` aufzuführen, als hätte die Anfrage beide getragen.

- Websites sehen Browser Use als den Chrome-Build, der sie rendert. Die Agent-Zeichenfolge trug weiterhin die Desktop-App-Version und die Electron-Runtime, während die Client Hints, die dieselben Seiten erhielten, allein Chromium nannten; GitHub beantwortete diesen Widerspruch mit einer Anmeldeschranke auf einem öffentlichen Repository. Die Browser-Partition präsentiert jetzt die schlichte Chrome-Zeichenfolge – ein Fingerabdruck weniger und weniger Umwege wegen „unsupported browser“ –, und ein emulierter User-Agent hat weiterhin Vorrang, wenn eine Aufgabe einen verlangt.

- Seiten, die ständig Frames anhängen, lassen sich wieder beobachten. Portale und Nachrichten-Startseiten öffnen Werbeplätze und Widgets in Schüben, und ein Snapshot, der mitten im Schub begann, gab früher mit „frame topology changed during observation“ auf – reproduzierbar beim ersten und zweiten Versuch. Beobachtungen haben keine Nebenwirkungen, daher wartet der Collector jetzt kurz, bis sich der Schub beruhigt, und liest erneut, bis zu einer kleinen Obergrenze, statt dem Aufrufer einen Fehler für eine Seite zu liefern, die lediglich beschäftigt war. Schlägt ein Lesevorgang dennoch fehl, sagt die Antwort jetzt, dass die Seite geladen ist und nur das Lesen fehlschlug, sodass der nächste Schritt darin besteht, erneut zu beobachten, statt eine einwandfreie Seite aufzugeben.

- Eine Seite meldet nur ihre eigenen Fehler. Anfragen und Konsolenfehler des vorherigen Dokuments blieben in den Protokollen, sodass ein Snapshot einer gesunden Seite abgebrochene Anfragen der zuvor besuchten Website auflisten konnte und `console` auf einer sauberen Seite mit den Fehlern der vorherigen Seite antworten konnte – beides schickte den Leser einem Fehler hinterher, der nicht da war. Das Laden eines neuen Dokuments löscht sie; die Navigation innerhalb desselben Dokuments behält sie, weil nichts neu geladen wurde.

- Display-Wettläufe bei Browser Use sind keine Fehler mehr. Eine Aufnahme, die gegen eine Navigation oder eine Fenstergrößenänderung verliert, antwortet jetzt mit einer Resample-Markierung statt mit einem Fehler, denn der Bereich würde ohnehin erneut anfragen, was die Seite als Nächstes zeigt. Gewöhnliches Surfen füllte früher das App-Protokoll mit Aufnahmefehlern – siebzehn in einem Harness-Lauf, jetzt keine –, und ein gekoppeltes Smartphone meldete denselben Wettlauf als „could not connect to browser screen“; es tastet jetzt in der aktiven Taktung neu ab und meldet nur ein Display, das tatsächlich keine Fortschritte mehr macht.

- Browser-Use-Browserdaten löschen. Der Browserbereich hat eine Radiergummi-Schaltfläche, die den Cache, die von Websites auf diesem Gerät gespeicherten Daten und Cookies entfernt, jeweils als eigene Entscheidung: Der Cache ist vorausgewählt, weil sein Verlust nur ein langsameres Neuladen kostet, während Cookies Sie von jeder Website abmelden und nie die Vorgabe sind. Jeder Bereich wird für sich gelöscht, sodass ein Fehler als Fehler gemeldet wird, statt hinter den erfolgreichen Bereichen zu verschwinden. Das Löschen von Cookies schreibt außerdem die versiegelte Datei neu, die Sitzungsanmeldungen über Neustarts hinweg trägt, sodass eine gelöschte Anmeldung beim nächsten Öffnen der App nicht zurückkehrt – und wenn diese Datei nicht neu geschrieben werden kann, werden Cookies als nicht gelöscht gemeldet statt als erledigt. Bisher wuchs die gemeinsame Partition auf der Festplatte ohne Möglichkeit, Platz zurückzugewinnen.

- Die `performance`-Metriken von Browser Use melden den Speicher des Prozesses, der die Seite zeichnet, nicht nur den JavaScript-Heap: Eine Seite, deren Bilder und Ebenen den Speicher belegen, sah früher klein aus. Die Messung nennt den Prozess, da ein Renderer mehrere Seiten derselben Website zeichnen kann.

- Die Domain-Richtlinie von Browser Use erfasst Peer-Verbindungen. Wenn ein Betreiber die Domains einschränkt, die eine Seite erreichen darf, umgeht WebRTC den Filter nicht mehr über STUN und TURN: Peer-Verbindungen werden in der Seite und in jedem Child-Frame abgelehnt. Ohne Domain-Richtlinie ändert sich nichts, und dies bleibt eine Eindämmung für Seitencode, keine Netzwerkgrenze.

- Element-Screenshots in Browser Use. `snapshot mode=visual` akzeptiert `ref` oder `target` und liefert dieses Element als eigenes Bild. Die Box wird in CSS-Pixeln des obersten Dokuments gemessen – Frames im selben Prozess rechnen ihren Versatz seitenseitig ein, ein Cross-Origin-Frame addiert seinen Sitzungsversatz ohne den Hit-Test, der die Eingabe schützt, weil ein Bild nichts auslöst und ein Frame unter einer CSS-Transformation trotzdem eines verdient –, und der Ausschnitt wird mit dem Verhältnis von Bild zu Viewport skaliert, sodass er auch auf einem gezoomten oder hochauflösenden Display stimmt. Ein Element, das höher oder breiter als das Fenster ist, wird aus der Dokumentaufnahme statt aus dem Viewport ausgeschnitten, sodass eine lange Tabelle oder ein langer Artikel vollständig ankommt, statt an der Falz zu enden; nur eine zu große Seite fällt auf den sichtbaren Teil zurück und sagt das. Das Bild dient nur der Inspektion: Es wird nie als Koordinaten-Grounding gebunden, denn der Ref bleibt der Weg, auf das Element zu handeln. `mode=semantic`, `fullPage` und `format=pdf` lehnen ein Ziel ab, statt es zu ignorieren.

- Eingabetreue bei Browser Use. `drag` schließt jetzt das eigene HTML5-Ziehen einer Seite ab: Chromiums Drag-Interception übergibt die Nutzlast, die die Seite gestartet hat, und die Geste endet als `dragEnter`/`dragOver`/`drop`, worauf eine Kanban-Karte, eine sortierbare Liste oder eine Datei-Ablagezone tatsächlich hört; Seiten, die nur Mausereignisse verfolgen, behalten den bisherigen Weg. `type` sendet pro Zeichen ein echtes Tastenereignis statt die ganze Zeichenfolge einzufügen, sodass tastenanschlaggesteuerte Autovervollständigung und Kombinationsfelder reagieren, während Zeichen außerhalb des US-Layouts (Koreanisch, Emoji) weiterhin als Text eingefügt werden. `press` sendet die US-Tastencodes für Satzzeichen (`.` war Delete, `-` war Insert), verhindert, dass ein Tastenkürzel ein Zeichen tippt, und leitet Shift nicht mehr aus einem Großbuchstaben ab, was `Control+A` zu `Control+Shift+A` gemacht hatte. `upload` legt Dateien auf einem Element ab, das nie einen Dateiauswahldialog öffnet, mit einer Schutzvorrichtung, die ein unbehandeltes Ablegen neutralisiert – sonst navigiert der Browser die Seite zur abgelegten Datei –, und meldet unmissverständlich, wenn nichts es akzeptiert hat.

- Beobachtungstreue bei Browser Use. `scroll text=` durchsucht Frames und Shadow Roots wie `read` und `expect`, wählt über sie hinweg einen Treffer und scrollt nicht mehr zu einem eingeklappten Element. `expect.text` normalisiert Leerzeichen innerhalb einer Zeile, behält aber Zeilenumbrüche, sodass eingerücktes Markup passt, während zwei getrennte Blöcke nie zu einem Satz verschmelzen. Konsolendiagnosen behalten, was eine Seite protokolliert hat: Objektargumente kommen als lesbare Vorschau statt als leere Nachricht an, Einträge nennen das Skript und die Zeile, die ein Leser öffnen würde, und ein nicht abgefangenes nacktes `throw` trägt seine Position. Snapshots markieren `aria-hidden`, ein fehlgeschlagenes natives `select` listet die gefundenen Optionen auf, und `aria-labelledby` wird innerhalb eines Shadow Roots aufgelöst.

- Browser Use zählt die Diagnosen, die nicht hineinpassten. Ein Seitenbericht zeigt die drei neuesten Konsolenfehler und Netzwerkfehler, was wie die ganze Geschichte wirkte: Zwölf Fehler kamen als drei an. Der Bericht nennt jetzt die Gesamtzahl und verweist auf `console` oder `network`, sobald die Liste begrenzt ist.

- Browser Use räumt ein, wenn ein Seitenauszug vorzeitig endet. Der sichtbare Text in einem Snapshot ist begrenzt, und der Bericht sagte nur „condensed“, sodass ein langer Artikel aussah, als wäre der Auszug die ganze Seite. Beide Snapshot-Wege – die Barrierefreiheitsaufnahme und der DOM-Fallback – markieren jetzt einen abgeschnittenen Auszug, und der Bericht nennt, wie viel er enthält, und sagt, dass die Seite mehr enthält.

- Anhänge melden die Größe des tatsächlich erzeugten Bildes. Das Einpassen eines Bildes in ein Vision-Patch-Budget beschneidet die Ränder einzeln, was eine Box verlangen kann, die das Bild nicht ausfüllt; die Ausgabe war dann kleiner als die daneben gemeldete Größe, und über diese Größe abgebildete Koordinaten waren falsch. Die Größenänderung meldet jetzt die Abmessungen des erzeugten Bildes.

- Browser Use sagt, wo ein Seitenskript fehlgeschlagen ist. `evaluate` behielt nur die erste Zeile des Browserfehlers, sodass ein mehrzeiliges Skript `TypeError: ...` meldete, ohne dass sich etwas lokalisieren ließ. Der Fehler trägt jetzt den innersten Stack-Frame mit sich, und der Integrations-Harness legt die Position fest, die ein throw in einer späteren Zeile meldet.

- Browser Use benennt ein PDF, statt eine leere Seite zu melden. Das Öffnen eines Links zu einem PDF übernahm die Adresse, aber der Gast hat dafür keinen Viewer, sodass der Snapshot eine unbenannte Seite ohne Text zeigte und Konsolenrauschen über ein blockiertes Viewer-Stylesheet – nichts, was sagt, was passiert ist. Der Seitenbericht gibt jetzt an, dass das Dokument ein PDF ist, das dieser Browser nicht anzeigen kann, und dass die Datei über ihre URL gelesen werden muss; die Fehler, die Chromiums eigene mitgelieferte Komponenten für ihre `chrome-extension://`-Ressourcen auslösen, erscheinen nicht mehr als Konsolen- oder Netzwerkfehler der Seite. Der Integrations-Harness deckt die Navigation, den ruhigen Bericht und einen späteren Snapshot der Seite ab.

- Browser Use lässt `close_tab` nicht mehr am sichtbaren Tab abprallen. `list_tabs` gibt die sichtbare Seite mit einer gewöhnlichen Seiten-ID aus, sodass `close_tab` darauf mit `unknown background tab "p12"; call list_tabs` beantwortet wurde – dem Listing, das die ID geliefert hatte. Die Ablehnung sagt jetzt, dass die Seite zum Browserbereich gehört, und verweist darauf, sie anderswohin zu navigieren oder `hide` zu verwenden; nicht zugeordnete Namen melden weiterhin einen unbekannten Hintergrund-Tab.

- Browser Use sagt, was eine Verlassen-Bestätigung tatsächlich bewirkt hat. Eine Seite, die ungespeicherte Arbeit schützt, stoppte eine Navigation mit einem `beforeunload`-Dialog, und die Antwort verlangte `handle_dialog` – aber Chromium beantwortet diese Bestätigung selbst, sodass der Aufruf immer mit „no JavaScript dialog is currently open“ zurückkam, während die Wiederholung der Navigation dieselbe Anweisung wiederholte. Die Antwort sagt jetzt, dass die Navigation abgebrochen wurde und die Seite blieb, dass nichts mehr zu beantworten ist und dass die Arbeit, die die Seite hält, zuerst abgeschlossen oder verworfen werden muss; der Integrations-Harness hält die gesamte Abfolge fest, einschließlich der Navigation, die durchgeht, sobald der Schutz weg ist.

- Die Locale-Emulation von Browser Use erreicht den Server. `emulate locale` setzte allein `navigator.language`, sodass die Seite weiter die alte Sprache anfragte und Websites Inhalte aushandelten, denen die Emulation widersprach; jetzt wird die Locale auch als `Accept-Language` übermittelt, und ihr Löschen stellt die browsereigene Aushandlung wieder her.

## v0.9.171 - 2026-09-18

- Release-Wiederherstellung: Das bereitgestellte Produktions-Relay-Artefakt ist nur noch am Lauf ausgerichtet (`production-relay-<run_id>`) und wird mit `overwrite: true` hochgeladen. Der Name trug den Run-Versuch, aber ein teilweiser erneuter Lauf behält den erfolgreichen Job `stage-production-web-relay` bei, während er `deploy-production-web-relay` als abhängigen Job des fehlgeschlagenen Jobs erneut ausführt, sodass das versuchsbezogene Artefakt nie existierte und der Deploy an „Artifact not found“ starb, bevor er die Produktion erreichen konnte. Genau so veröffentlichte v0.9.170 sein GitHub-Release und das npm-Paket, ohne das Web-Relay zu deployen. `overwrite: true` verhindert, dass ein vollständiger erneuter Lauf, bei dem der Stage-Job tatsächlich erneut läuft, mit dem Artefakt des früheren Versuchs kollidiert, und das Release-Gate prüft sowohl den Namen als auch das Überschreiben.

## v0.9.170 - 2026-09-17

- Konsolidierung des System-Prompts. Jede Regel hat jetzt einen einzigen Besitzer: Die gemeinsame Ebene (`rules/shared/*.md`) ist ausschließlich Tool-Richtlinie und beginnt mit `# Tool Calls` (Batching zuerst; `05-parallel-calls.md`), die Lead-Rolle ist eine Datei (`rules/lead/LEAD.md`: Kommunikation mit dem Nutzer, Briefing von Agenten und Abschlussbenachrichtigungen hinter `<!-- tools: agent -->`, Ton), und der gemeinsame Agentenvertrag ist eine Datei (`rules/agent/AGENT.md`: Befehlskette, keine Selbstverifizierung, Englisch, Form der Übergabe). `00-general.md`, `02-persona.md`, `lead-brief.md`, `00-core.md`, `00-common.md` und `75-goal.md` entfallen – ihre weiterhin gültigen Sätze wanderten in die Datei, der sie gehören, und Sätze, die eine Tool-Beschreibung bereits enthält (`load_tool`, `Skill`, `goal`, `memory`-Genehmigung, `task wait`, `code_graph`-Outline, Form des read-Aufrufs, Git-Routing, Browser-/Computer-Routing), stehen nur dort. Die Rangfolge gilt pro Rolle: die letzte ausdrückliche Anfrage des Nutzers für Lead, das letzte Briefing von Lead für Agenten. Die Präambelregel von Lead nennt jetzt ihren Grund (der Nutzer sieht nur Ihren Text) und verlangt eine Zeile statt einer Wortzahl; die Briefing-Regel besagt, dass ein Agent die Unterhaltung nie sieht, dass Erkenntnisse zu Pfaden, Zeilen und der genauen Änderung zusammengeführt werden („based on your findings“ nie) und dass das Ergebnis eines Agenten nie vorhergesagt wird. Regeln zu destruktiven Aktionen, die über vier Abschnitte verteilt waren, stehen in einem einzigen Abschnitt `# Destructive Actions`. Rollendateien (`agents/*/AGENT.md`) lassen die Blocker-/Übergabesätze weg, die der Vertrag besitzt; `maintainer` erhält Name und Beschreibung im Frontmatter. Output-Styles: Die Überschrift `## Depth` ersetzt `## Depth Variation`, und die Formulierung zu Fortschrittsberichten steht nur in den Lead-Regeln. Der Default-Workflow enthält den Reviewer-Fallback-Absatz nicht mehr; er reist mit dem Orchestrierungsmodus-Block, den delegierende Modi einfügen. Tool-Beschreibungen: `edit` verweist nicht mehr auf `apply_patch` auf Oberflächen, die es herausgefiltert haben, `shell` sagt, dass Git nur dann an `git` geht, wenn dieses Tool vorhanden ist, `read`/`grep` lassen Byte-Obergrenzen weg, die die Runtime ohnehin meldet, und `code_graph` stellt klar, dass `symbols` die Outline ist. Anbieter, die die Runden-Erinnerung selbst liefern (`anthropic-oauth` als durchlaufbezogene Systemnachricht, `cursor` über sein Relay), deklarieren `deliversRoundReminder`, sodass der Runtime-Kanal still bleibt – Cursor-Sitzungen erhalten die Batching-Erinnerung nicht mehr zweimal pro Runde. Die Herkunftsprüfung des Batching-Hinweises normalisiert Pfadtrennzeichen und akzeptiert ein Verzeichnis, das im vorherigen Ergebnis als Präfix eines tieferen Pfads gezeigt wurde, sodass ein Folgeaufruf zu einem Pfad, den das letzte Ergebnis enthüllt hat, nicht mehr als unabhängiger Einzelaufruf gilt (vorher zwei Fehlalarme pro Sitzung). Das `setup`-Route-Schema gibt `contextPercent` als begrenzte Ganzzahl an (der Executor verlangt weiterhin ein Vielfaches von 10), damit Gemini keinen nicht darstellbaren Enum-Platzhalter mehr erhält. Veraltete Testerwartungen, die der Batching-Commit hinterlassen hat, wurden aktualisiert, und zwei zeit-/umgebungsabhängige Tests wurden deterministisch gemacht. Der Projekt-Skill `gamerscroll-article` ist auf sein Projekt beschränkt.
- GitHub-Releases tragen jetzt den CHANGELOG.md-Abschnitt der Version als Notizen, gefolgt vom Vergleichslink; der Entwurf verließ sich bisher auf die von GitHub generierten Notizen, die nur gemergte PRs auflisten und die Seite mit einem nackten `Full Changelog`-Link zurückließen, weil Deploy direkt auf main committet.
- Tool-Batching: Nach drei aufeinanderfolgenden Einzelaufruf-Runden eines Tools, deren Aufrufe einander nicht brauchten (kein Argument aus dem vorherigen Ergebnis, kein Schritt, der hinter eine Mutation geordnet ist; ein anderes Tool startet die Serie neu, sodass read → shell → apply_patch nie gemeldet wird; Task-Waits, Computer Use, Browser-Schritte und Schema-/Skill-Ladevorgänge zählen nie), oder nach einer Runde gleicher Tool-Aufrufe, die sich nur in einem Array-Feld unterscheiden, hängt die Runtime eine kurze `<system-reminder>` an, die die Array-Argumente auf der Tool-Oberfläche der Sitzung nennt; sie wiederholt sich, sobald das Muster wiederkehrt, und nur eine gebündelte Runde löscht sie (aufgezeichnet als `batching_nudge`). Ein einzelner `read` einer Datei direkt nach einer grep-/code_graph-/glob-/find-Runde, die mehrere Dateien gefunden hat, erhält die gefundene Menge in der Form zurück, die ein `read`-Aufruf annimmt (`[{file_path, offset, limit}, …]`; bei Anbietern, deren read-Schema nur Pfad-Strings akzeptiert, ein read pro Datei in derselben Antwort), aufgezeichnet als `located_sites`: Eine aufgezeichnete Sitzung mit Gemini 3.8 Flash fand Dateien 13-mal mit grep und las sie trotzdem Fenster für Fenster (63 Lesevorgänge, 20 von 28 Dateien zwei- oder mehrfach gelesen). Die Beschreibungen von `read` und `grep` sagen jetzt, was der Batch ist – jede Datei und jeder Bereich, die Sie berühren werden, vor dem Bearbeiten, in einem Aufruf –, und die Fußzeile des fensterweisen Lesens verlangt einen breiteren Lesevorgang statt des nächsten Fensters. Die gemeinsamen Regeln geben die Reihenfolge der Arbeit an Dateien jetzt einmal an (`# Tool Calls`: nur auflisten, wenn der Umfang unbekannt ist → jede Stelle lokalisieren → eine Lesestufe aus `{file_path, offset, limit}`-Fenstern, ≤10 pro Aufruf → jede Bearbeitung in einer Antwort → eine Verifizierung) und entfernen die Sätze, die Teile davon früher an drei Stellen sagten; die Beschreibungen von `read`, `grep`, `edit`, `apply_patch` und `code_graph` schrumpfen auf diesen Vertrag (code_graph von ca. 150 auf ca. 90 Wörter), und die Smart-Cap-Markierung eines fensterweisen Lesens nennt die Form mit lokalisierten Fenstern; ein weiterer Durchgang kürzt Parameterprosa, die die Regeln oder interne Details wiederholte (`Skill`, `find`, `cwd`, `git`, `code_graph.mode`, `grep.path`/`text`, `include_noise`, der PowerShell-Spickzettel von shell und `timeout_ms`) – die Tool-Oberfläche von Lead sinkt von 13,4 KB auf 12,7 KB. Acht-Aufgaben-Läufe mit GPT-5.6 vorher und nachher bleiben bei 8/8 mit demselben Rahmen aus Runden, Zeit und Kosten; die eine unterwegs gefundene Regression (eine Backup-Runde für schreibgeschützte Eingaben und `git log`-Überblicke, nachdem zwei schützende Klauseln gestrichen wurden) ist behoben. Die Backup-Regel sagt jetzt, wohin die Kopie gehört – in dieselbe Antwort wie die erste Inspektion, nie in eine eigene Runde –, weil „inside the first inspection call“ GPT-5.6 pro Acht-Aufgaben-Lauf 2,8 reine Backup-Runden öffnen ließ, wenn die erste Inspektion ein `read`- oder `git`-Aufruf war; mit korrigierter Formulierung öffnete es keine und bündelte jedes Backup mit dieser Inspektion. Die Serien-Erinnerung behandelt ein Array innerhalb eines einzelnen Aufrufs nicht mehr als Batch: Ein aufgezeichnetes Review mit Gemini 3.8 Flash führte fünfzehn Einzelaufruf-Runden aus, abwechselnd mit ein- und zweibefehligen `git`-Aufrufen, und verdiente die Erinnerung nie, weil jede Array-Runde die Serie zurücksetzte. Die Herkunftsprüfung merkt sich außerdem sechs Runden statt zwei, sodass eine Dateiliste aus `git diff --name-only`, die Eintrag für Eintrag in je einer Runde abgearbeitet wird, nicht mehr jeden Eintrag als Ergebnis des vorherigen Diffs wertet. Zwei weitere Runtime-Erinnerungen: `late_locating` (eine Suche nach einem read, der nichts daraus übernommen hat) und `located_sites`, das ein Fenster pro lokalisierter Stelle übergibt – einschließlich code_graph-`(Lstart-end)`-Zeilen –, bei mehr als zehn Fenstern auf mehrere read-Aufrufe aufgeteilt. Routen-Richtliniendateien (`rules/routes/*.md`) deklarieren jetzt zusätzlich zu ihren statischen Regeln eine einzeilige `turn-reminder:` (einmal im abschließenden `<system-reminder>`-Block des Nutzer-Durchlaufs gelesen, vor der ersten Antwort des Durchlaufs) und eine einzeilige `round-reminder:`; die Agentenschleife löst Letztere pro Anbieter/Modell auf, und sie erreicht das Modell nach jeder Tool-Runde – als durchlaufbezogene Systemnachricht von Anthropic (`clear_at: next_user_message`) bei `anthropic-oauth`, dem Muster, das Anthropic für Claude Fable 5.1 dokumentiert, oder anderswo als Runtime-`<system-reminder>` nach Einzelaufruf-Runden (`per_round`). Die Fable-5.1-Erinnerung wandert von einer hartkodierten Anbieterkonstante in die Routendateien; unter dem früheren Satz aufgezeichnete Verläufe spielen sie byte-genau ab. Eine Datei, `routes/common.md`, trägt die Batching-Erinnerungen für jede Route (eine unbeschränkte Datei ist die Basis; eine Datei, die `models:` oder `providers:` benennt, ergänzt diese Zeile für ihre Routen, statt sie zu ersetzen) – Gemini macht einen Aufruf pro Runde, sobald Tool-Ergebnisse eintreffen, Grok bündelt Aufrufe, nutzte aber nie Array-Argumente: Seine abgeflachten Tool-Schemas behielten bei jedem Feld, das einen oder mehrere Werte annimmt, nur den skalaren Zweig (`read.file_path`, `grep.pattern`, `git.command`, …). Das Abflachen für Grok behält jetzt den Array-Zweig solcher Felder (ein Wert reist als einelementiges Array) und sagt das in der Feldbeschreibung, sodass der Batching-Vertrag auch bei diesem Anbieter gilt. Die gemeinsamen Regeln erhalten einen Abschnitt `# Parallel Tool Calls`, der den Vertrag klar benennt (aufgezeichnete Sitzungen mit Gemini 3.8 Flash gaben in 105/105 Runden einen Aufruf pro Runde aus; mit dem Abschnitt bündelte ein Headless-Lauf vier Dateien und git in einer Antwort). Anbieter-/modellgebundene Regeln werden aus `rules/routes/*.md` über das Frontmatter `providers:` / `models:` geladen und nach den gemeinsamen Regeln in BP1 gerendert. `MIXDOG_ANTIGRAVITY_DUMP_DIR=<dir>` schreibt jeden Antigravity-Request-Body (Inhalte, Tools, Konfiguration; nie Header oder Tokens) zur Wire-Inspektion, das Gemini-Gegenstück zu `MIXDOG_OAI_WS_DUMP_DIR`; `mixdog exec` reicht außerdem `MIXDOG_XAI_CACHE_TRACE` und `MIXDOG_XAI_RESPONSES_CACHE_SCOPE` für xAI-Cache-Tests durch.
- xAI-Responses-Anfragen senden standardmäßig keinen `prompt_cache_key` pro Sitzung mehr (`MIXDOG_XAI_RESPONSES_CACHE_SCOPE` ist jetzt standardmäßig `none`, der literale Body von Grok Build): Der Sitzungsschlüssel teilte den Service-Cache in Spuren auf und maß zwei kalte Runden pro Lauf statt einer sowie keine sitzungsübergreifende Präfix-Wiederverwendung. `session` und `prefix` bleiben wählbar. `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED` überschreibt den Function-Calling-Modus von Antigravity für A/B-Läufe, und `benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs` meldet Raten von Mehrfachaufrufen und Array-Argumenten pro Modell aus `agent-trace.jsonl`.
- `mixdog exec` bindet das im Provider-Accounts-Pool des Hosts ausgewählte OAuth-Konto (die Zugangsdaten, die die Anmeldung heute schreibt) und fällt auf die einzelne Legacy-Zugangsdatei zurück; bisher wurde nur die Legacy-Datei oder ein expliziter `*_CREDENTIALS_PATH` akzeptiert, sodass Hosts mit reinem Pool mit „credentials are unavailable“ scheiterten. `mixdog exec` sitzt außerdem nicht mehr 2–4 Minuten nach seiner Antwort fest, bevor es `result` ausgibt: Das Entfernen der unberührten Wurzel wurde unter Windows für das volle rmSync-Budget wiederholt (50 lineare Wiederholungen ≈ 128 s, zweimal, wenn der Postmaster-Pfad es erneut ausführte), während das SQLite-Handle des Nutzungsbuchs und die `pg.log` eines auslaufenden Memory-Daemons noch offen waren. Das Buch wird vor dem Entfernen geschlossen, und exec übergibt ein Budget von 10 Wiederholungen (≈5,5 s) (`cleanup({ rootRemovalRetries })`). Ein verbliebenes Stammverzeichnis wird später durch die regelmäßige Bereinigung verwaister Verzeichnisse entfernt.

## v0.9.169 - 2026-09-16

- Code Tidy: Die Installation lädt jetzt die Kern-Engines (Biome, ruff, shfmt, shellcheck, PSScriptAnalyzer) mit Fortschrittsanzeige herunter, und die eingebaute Karte listet jede Engine mit Version, Sprache, Quelle und Größe auf; später von einem Projekt aufgenommene Engines erscheinen in derselben Liste. Zum Tidy-Zeitpunkt fehlende Engines werden standardmäßig automatisch heruntergeladen (`tidy.downloads` beachtet weiterhin `ask` und `never`). PSScriptAnalyzer ist ein per sha256 verifizierter verwalteter Download aus der PowerShell Gallery statt eines reinen Host-Moduls, und C# erhält einen echten dotnet-format-Runner. Korrekturen: Diff-Header von rustfmt 1.9 und `\\?\`-Pfade werden geparst, große Biome-Berichte kollabieren bei gestückelter Ausgabe nicht mehr auf null Befunde, die Behebbarkeit wird über `biome explain` klassifiziert, und die Regel für Verlaufskommentare entfernt nur Kommentare, die vollständig aus Verlauf bestehen, und reicht nie über den Kommentar hinaus (sie konnte die nächste Anweisung löschen).
- Seitenleistenzeilen teilen sich ein Statusetikett neben dem Titel für Built-ins, Plugins, Skills, MCP-Server, Zeitpläne, Webhooks und Agenten: nichts, wenn aktiviert, sonst `Not used`, `Not installed`, `Installing… N%`, `Failed` oder `Not connected`. Deaktivierte Agenten behalten ihre Modellzeile.
- FastDirect weigert sich, eine `app.asar` neu zu packen oder zu installieren, deren Produktionsabhängigkeitsschluss unvollständig ist, und fällt auf einen vollständigen Build zurück, sodass ein defekter Updater (`Cannot find module 'graceful-fs'`) nicht mehr von jedem inkrementellen Update geerbt wird.
- Abgeschlossene Agent-Worker werden nicht mehr durch Sitzungsscans oder die Desktop-Agentenliste wiederbelebt; neu registrierte beendete Sitzungen behalten ihre echte Endzeit, sodass Leases ablaufen, statt jede Stunde neu zu starten.
- Die Orchestrierungsmodi `none`, `focused`, `balanced` und `swarm` ersetzen den Solo-Workflow und werden pro Sitzung gewählt; die Einstellungen sind lokalisiert.
- Desktop: Lokale Pfadlinks in Markdown öffnen sich im Editor, und der Editor öffnet Dateien außerhalb des Projekts.
- Browser Use serialisiert Snapshots pro Seite und härtet die Pfade für Beruhigung und Aufnahme.
- Computer Use: Ein eingefrorener Overlay-Renderer wird stillgelegt und ersetzt, der Eingabe-Wiederherstellungszustand übersteht den Wechsel, und die Overlay-Fixtures beenden sich auf einem Rechner mit einem Display nicht mehr vorzeitig.
- Shell: PowerShell-Hosts blockieren `grep`, `sed` und `awk` im Preflight nicht mehr hart; die Tool-Beschreibung verweist stattdessen auf die dedizierten Tools. Regeln, Skills, README und das neue `docs/context-efficiency.md` wurden aktualisiert.
- Das Repository wird mit Biome 2.5.13 (`biome.json` legt den bestehenden Stil fest), rustfmt, dotnet-format und PSScriptAnalyzer formatiert; ungenutzte Importe, tote Helfer und nur dateiintern verwendete Exporte wurden entfernt.

## v0.9.168 - 2026-09-16

- Das Schließen einer Computer-Use-Sitzung sendet immer ihre eigene Freigabeanfrage. Die spekulative Freigabe des Leerlauf-Timers wurde früher geerbt, wenn sie noch unterwegs war, sodass eine abgelehnte frühe Freigabe die Worker- und Fensteransprüche der schließenden Sitzung bis zum Neustart der App festhalten konnte.

- Computer-Use-Overlay: zwei Bedienelemente, Stopp und Fortsetzen. Die Pause-Schaltfläche entfällt (das Berühren des Desktops übergibt die Kontrolle bereits an den Nutzer); die Pille zeigt jetzt, warum ein Bedienelement nicht verfügbar ist oder warum eine Anfrage fehlgeschlagen ist, statt stumm zu reagieren. Stopp behebt einen eingerasteten Bereinigungsfehler, sobald jeder Eingabe-Worker beendet ist, sodass der Host keinen App-Neustart mehr braucht, und die Bestätigung des Worker-Exits wartet bis zu 5 Sekunden statt 1.
- Computer Use nimmt ein Fenster von seiner eigenen gerenderten Oberfläche auf, statt den Desktop zu kopieren, mit einem begrenzten Aufnahmebudget; eine unbestätigte Ressourcenfreigabe legt diesen Worker still. Hintergrund-Tastatur und -Eingabe werden vor dem Senden jeder Eingabe geprüft, sodass eine nicht unterstützte Route nichts tut. Ein neuer Befehl wartet, bis die vorherige Sitzungsfreigabe bestätigt ist. Stopp wartet außerdem unabhängig von der nativen Eingabebereinigung auf den Abbruch des Agenten-Durchlaufs.
- Browser-Use-Wartezeiten beachten Abbrechen und weigern sich, eine URL mit Text eines späteren Dokuments zu vermischen; eine fehlgeschlagene Wiederherstellung eines Ganzseiten-Screenshots ist endgültig. CSS-Selektoren behalten innere Leerzeichen, lehnen übergroße Treffermengen ab und adressieren jeden Treffer eindeutig. Gleichzeitige Downloads teilen sich eine Byte-Gesamtsumme pro Sitzung; Genehmigungsabfragen beschreiben Aktionen und Adressen, nie Formularwerte.
- Code Tidy ist ein installierbares Built-in, wie Office: Einstellungen → Built-in installiert und schaltet es um, und der Skill `code-tidy` steuert das Tool `tidy`. Der Scan erkennt die Sprachen eines Projekts und löst jeden Formatter oder Linter aus der Projektkonfiguration, dann aus projektlokalen Binärdateien, PATH oder einem per sha256 verifizierten verwalteten Download (ask, auto oder never) auf. Er führt Biome, ruff, clang-format, shfmt, shellcheck, StyLua, gofumpt, dprint, Air und Mago aus, dazu rustfmt, gofmt und PSScriptAnalyzer der Toolchain, und wendet strukturelle Pakete (Entfernen von Verlaufskommentaren, `debugger`, leerer catch, TODO-Markierungen) in 31 Sprachen an. `fix` ist ein Probelauf, sofern apply nicht gesetzt ist, und Schreibvorgänge laufen über dieselbe Pipeline wie andere Bearbeitungen. Engine-Lizenzen werden mit dem Tool ausgeliefert.
- `code_graph`-Aufrufer und -Aufgerufene stammen aus geparsten Aufrufstellen, nicht aus Textsuche; aufrufförmige Referenzen nutzen ebenfalls diese Stellen. Eine ältere Graph-Binärdatei, die sie nicht ausgeben kann, scheitert mit einem Hinweis zum Neubau statt mit einer leeren Antwort. Outline-Zeilen verwenden ein einheitliches Vokabular für Arten, markieren Exporte, zeigen Signaturen und verschachteln Member unter ihrem Elternelement. `find_symbol` bevorzugt eine Implementierungsdatei gegenüber einer begleitenden `.d.ts` und meldet, wenn die Deklaration außerhalb der angefragten Dateien liegt. Bezeichner-Tokens stammen aus dem Parse-Baum, sodass ein Name, der nur in einem Kommentar vorkommt, nicht mehr als Referenz zählt. Solidity, Haskell und HCL kommen mit Import-Kanten zur Extraktionsmenge hinzu (24 Extraktionssprachen, 31 geparst). Aufrufstellendaten liegen in einem Sidecar-Cache, sodass der Haupt-Graph-Cache gleich groß bleibt.
- Die native Graph-Binärdatei bettet tree-sitter 0.27 und ast-grep 0.45.3 ein, ergänzt die Modi `--scan`, `--langs` und `--outline` und extrahiert Symbole, Importe und Bezeichner-Tokens aus YAML-Regeln.
- Die Graph-Fallback-Outline des Desktop-Editors parst die neuen Symbolzeilen zu einer verschachtelten Outline mit Art-Symbolen.
- Strukturfragen (Exporte, Signaturen, Member, Aufrufer, Importeure) gehen an `code_graph`, bevor `read` oder `grep` zum Zug kommen; die Formulierung zur Parallelität im Tool-Workflow ist eine einzige Regel.
- Die Memory-Wartung befördert Unterhaltungszusammenfassungen nicht mehr zu dauerhaften Anweisungen: Es gibt keinen dritten Zyklus. Zyklus 2 prüft den Suchverlauf auf Duplikate und Herkunft, ohne Zusammenfassungen umzuschreiben. Das dauerhafte Gedächtnis bleibt vom Nutzer über `memory` kuratiert; `recall` durchsucht standardmäßig den gesamten Verlauf, einschließlich zuvor archivierter Zeilen.
- Die Antigravity-Gemini-Nutzung zeigt gemeinsame 5-Stunden- und Wochenfenster aus der Kontingentübersicht des Kontos statt Katalogzähler pro Modell, und Anfragen nutzen den täglichen Kanal ohne automatisches Host-Failover.
- Der Agenten-Bereich klappt nur Zeilen auf, die Sie öffnen, zeigt bei Lead die Anzahl der Nachfahren und sagt „Waiting for agents“, solange Nachfahren noch arbeiten, statt das Elternelement als untätig oder abgeschlossen zu behandeln.
- Das Eingabefeld bietet eine kleine Slash-Befehls-Palette für häufige Befehle (`/new`, `/model`, `/compact`, `/context`, `/goal`, `/inherit`, `/fast`); die vollständige Registry läuft weiterhin, wenn direkt getippt.
- Dateierwähnungen in der Unterhaltung bleiben reiner Text, bis der Pfad im zugehörigen Projekt bestätigt ist; Ordner und Dokumente öffnen sich weiterhin im Betriebssystem, und Editor-Öffnungen übergeben ein Zugriffstoken.
- Die Nutzungsübersicht in der Seitenleiste richtet Anbieterbezeichnungen, Anzeigen, Prozentwerte und Rücksetzzeiten an einem Raster aus; der Modellkatalog behält sieben zuletzt verwendete.
- Eine neue Sitzung wartet, bis ausstehende Einstellungsspeicherungen abgeschlossen sind, und MCP-Tools, die den aktuellen Katalog verlassen haben, werden nicht mitten im Durchlauf aufgerufen.

## v0.9.167 - 2026-09-15

- Der Sitzungsstart meldet, welche gängigen Shell-Tools vorhanden sind („Shell tools at startup“), gemessen in der Login-Shell unter POSIX und im Prozess-PATH unter Windows, sodass ein Modell nicht mehr `python` gegen `python3` rät oder `file` aufruft, wo es fehlt; eine unbekannte Antwort wird nicht dargestellt.
- `read` stellt überlappende Fenster einer Datei einmal dar, meldet ungelesene Bearbeitungsbereiche nicht mehr als bereits geliefert und erbt nach einer Dateiänderung nie eine veraltete Markierung „gesamter Body geliefert“; Array-Lesevorgänge beachten ihre No-Stub-Option, und die Beschreibung nennt die tatsächlichen Ausgabe-Obergrenzen.
- `git` führt mit `&&` verkettete Befehle als geordnetes Array (bis zu 10) aus, statt sie abzulehnen, und erkennt Bare-Repositories.
- Der Lese-Cache der Sitzung beachtet die Tool-Allowlist, erkennt reine `ctime`-Änderungen, speichert nie einen Body, der vor einer Änderung mitten im Lesen erfasst wurde, hält öffentliche und Legacy-Offset-Hinweise getrennt und deckt öffentliche Array-Lesevorgänge ab.
- `web_search`-Arrays kennzeichnen teilweise und vollständige Fehlschläge weiterhin als Fehler.
- Regeln und eingebaute Tool-Beschreibungen sind bei gleichem Verhalten kürzer: Die `shell`-Beschreibung trägt die Zuordnung Befehl→Tool und verbietet Tool-Namen als Shell-Befehle; die Hinweise zu `timeout_ms` decken Wegwerfprüfungen ab; Lead-Hinweise, die nur mit dem Tool `agent` gelten, entfallen in Workflows ohne Delegation; die Regeln verlangen jede unabhängige Aktion, die die aktuelle Evidenz erfordert, in einer Antwort, das direkte Patchen aus entscheidender Evidenz, ein Muster vor der Parsing-Logik und begrenzte Ausschnitte für große oder binäre Daten.
- Die Desktop-Runtime wurde mit der aktuellen Arbeit am Browser- und Computer-Harness synchronisiert, und die Tool-Vertragstests wurden entsprechend gehärtet.

## v0.9.166 - 2026-09-14

- Studio erkennt das ausgewählte ChatGPT-Konto nach der Anbieteranmeldung und Kontowechseln, über denselben Zugangsdatenpfad wie der Chat, ohne auf die Zugangsdaten eines anderen Kontos zurückzufallen.

## v0.9.165 - 2026-09-14

- Das Source-Control-Dock hält sein Zeilenfenster an die Live-Liste gebunden: Ein neu aufgebautes Dock (Tab-Wechsel, Erstlauf-Oberfläche zur Liste) scrollt nicht mehr in leere Zeilen.
- macOS-Release-Assets werden auf beiden Architekturen über das Skript „Löschen, dann erneut versuchen“ hochgeladen, sodass ein Wiederherstellungslauf nicht mehr an einem Asset scheitert, das im verborgenen Entwurf bereits existiert.
- Release-Gate: Jede Lane läuft auf den gehosteten Runnern grün. Linux installiert NanumGothic für Hangul-PDFs und das aktuelle LibreOffice für gerenderte Reviews; die Windows-Cursor-Prüfung legt ihre Bewegungspräferenz fest; Testerwartungen folgen den ausgelieferten Verträgen.

## v0.9.164 - 2026-09-14

- Die gemeinsamen Regeln, die Lead-Regeln und die eingebauten Tool-Beschreibungen wurden bei gleichem Verhalten auf weniger Tokens verdichtet; die `shell`-Beschreibung behält nur ihre Rolle, die Abgrenzung zu den dedizierten Datei-/Such-/Git-Tools und den Vertrag für Hintergrund-Tasks.
- Headless-Läufe (`mixdog exec`) geben an, dass während des Laufs kein Nutzer eingreift: Die Anfrage gilt als genehmigt und wird bis zum Ende ausgeführt, bevor berichtet wird, statt anzuhalten, um eine Frage zu stellen, die niemand beantworten kann.
- In die Shell getipptes `apply_patch` wird nicht mehr zur Patch-Engine umgeleitet; das Modell ruft `apply_patch`/`edit` direkt auf.
- Ein gestopptes Goal wird wie ein abgeschlossenes zurückgezogen: Die nächste Eingabe des Nutzers archiviert es, und das Bestätigen eines Stopps archiviert es sofort.
- Die Nutzungsstatistik ordnet gemessene Tokens und Kosten pro Anfrage im Buch zu, und der Desktop-Nutzungs-Explorer zeigt die resultierende Aufschlüsselung.
- Korrekturen am Wire-Format des Cursor-Anbieters.

## v0.9.163 - 2026-09-10

- Überarbeitung der UI-Lokalisierung, der Auswahl der Startsprache, der nativen Menüs und der übersetzten Formatierung; der Web-Sprach-Bootstrap bleibt über Updates hinweg aktuell.
- Härtung der Eingabe-Eigentümerschaft und der reinen Beobachtungsprüfungen von Computer Use, Bestätigung von Electron-Textzielen vor dem Tippen und Verbesserungen bei Cursor- und Sitzungsbehandlung.
- Verbesserung der nativen Dateisuche und der bereichsweisen Lesevorgänge sowie Verhinderung, dass ungültig gewordene oder abgebrochene laufende Berechnungen den Ergebnis-Cache wieder füllen.
- Enthält Such-Benchmarks, Regressionsabdeckung, Lokalisierungsaudits sowie generierte Projekt- und Dokumentergebnisse.

## v0.9.162 - 2026-09-09

- Der Dialog „Ziel festlegen“ öffnet sich zentriert in dem Bereich, dessen Eingabefeld ihn ausgelöst hat, und dunkelt nur diesen Bereich ab; benachbarte Bereiche bleiben sichtbar und nutzbar, und die Titelleiste wird nicht mehr abgedunkelt. Außerhalb eines Bereichs fällt er auf die Fensterebene zurück.
- Ein fokussierter Bereich verdeckt den Teilungsgriff an seinem eigenen Rand nicht mehr: Ein Browserbereich (oder jeder fokussierte Bereich) lässt sich wieder an seiner linken/oberen Grenze in der Größe ändern.
- Web Fetch meldet eine Stufe, die an der Gesamtfrist abläuft, als `FETCH_TIMEOUT` statt als `STAGE_TIMEOUT`.
- Computer Use nutzt für unterstützte semantische Eingaben standardmäßig die Hintergrundzustellung; `foreground_unavailable` bittet den Nutzer jetzt, das Zielfenster zu aktivieren, statt einen Vordergrundsperre-Fehler zu beschreiben.
- Der Release-Lauf von v0.9.162 stoppte am Test-Gate und lieferte nichts aus; seine nachstehenden Notizen werden mit diesem Release ausgeliefert.

- Mixdog steht jetzt unter der Apache-2.0-Lizenz statt unter MIT. Komponenten von Drittanbietern behalten ihre bestehenden Lizenzen und Hinweise zur Namensnennung.

- Browser Use und Computer Use fragen einmal pro Sitzung vor ihrem ersten Live-Aufruf nach. Der erste `browser`-/`browser_devtools`- oder `computer`-Aufruf eines Modells in einer Sitzung läuft über die Tool-Genehmigungsabfrage mit der Aktion, die es ausführen will; Zulassen gilt für den Rest der Sitzung, Ablehnen gibt dem Modell den Grund samt der Anweisung zurück, es nicht erneut zu versuchen, und ein Neustart fragt erneut. Sitzungen ohne Genehmigungsoberfläche (headless, Agent-eigen) werden nicht gesperrt. `setup set_first_use_approval name:browser|computer enabled:false` schaltet das pro Fähigkeit ab, und `MIXDOG_BRIDGE_FIRST_USE_APPROVAL` überschreibt es pro Prozess.

- Browser Use fasst zwei Gesten mit benachbarten zusammen. Eine Checkbox oder ein Radiobutton wird mit `fill` und `checked` statt `text` gesetzt – für ein Steuerelement, ein `fields`-Element oder einen `sequence`-Schritt –, sodass die separate Aktion `check` entfällt; und `forward` entfällt, da der frühere Snapshot bereits die URL für `navigate` zeigte, während `back` eine Geste bleibt. `locate` und `extract` bleiben: Ersteres ist eine visuelle (Pixel-)Suche ohne semantisches Äquivalent, Letzteres liest Zeilen über Frames und offene Shadow Roots hinweg, die `evaluate` nicht erreicht.

- `capture` von Computer Use verliert seine Stellschrauben `quality`, `maxWidth` und `max_ocr_words`: Es gelten die abgestimmten Vorgaben des Hosts (JPEG-Qualität, Verkleinerungsbreite und eine OCR-Wortgrenze, die das Elementbudget ohnehin begrenzt), und unlesbare Details sind ein `zoom` statt einer erneuten Kodierung. Die Elementfilter (`query`, `role`, `visible_only`, `include_noninteractive`, `continuation`) und die Verschiebungsgeometrie von `window` sagen jetzt, was sie tun, statt unerklärt im Schema mitzureisen.

- Browser Use und Computer Use geben ihre Sprosse auf der Tool-Leiter dort an, wo das Modell entscheidet. Die `browser`-Beschreibung beginnt mit „last resort: prefer web_fetch, an MCP tool, or a CLI in shell“, `computer` mit „last resort after an MCP tool, shell/CLI, and Browser Use; never a stand-in for a page action browser refused“, und die gemeinsamen Regeln sowie beide Skills tragen dieselbe Leiter, sodass ein Dienst mit API oder CLI darüber statt über einen Bildschirm erreicht wird. Keine der Beschreibungen wuchs: Die Leiter ersetzte Formulierungen, die die Skills bereits besaßen.

- Browser Use besteht aus zwei Tools. `browser` behält die alltägliche Seitenarbeit – navigate, snapshot, read, click, fill, Formulare, Dialoge, Tabs, Downloads, Lesen von Konsole und Netzwerk –, während die Entwicklersteuerungen `emulate`, `cookies`, `storage`, `intercept`, `init_script` und `performance` in das zurückgestellte Tool `browser_devtools` wandern, das dieselben Seiten und Anmeldungen bedient und sein Schema beim ersten Aufruf lädt. Das Alltagsschema verliert die 33 Felder, die nur diese Aktionen nutzten (Cookie-Attribute, Geolokalisierung, CPU-Drosselung, Intercept-Bodys, Trace-Optionen), die Feldhinweise jedes Tools nennen nur die eigenen Aktionen, und ein Aufruf, der das falsche Tool erreicht, wird mit dem Hinweis auf das aufzurufende Tool abgelehnt. Der Host, sein Aktionsregister, die Genehmigungsrichtlinie und der Integrations-Harness behalten den einen gemeinsamen Aktionsvertrag.

- Eingebaute Tool-Schemas legen nur Verträge fest. Die Beschreibungen und Feldhinweise der Tools `office`, `computer`, `media` und `setup` lassen die Methoden- und Richtliniensätze weg, die ihre Skills bereits besitzen – Batching, wann ein Snapshot oder `describe` nötig ist, das Beheben eines Audits im selben Durchlauf, die Wiederverwendung von `design.content`, Makrobehandlung, Nicht-Umordnen, Bildschirminhalte, die nie eine Aktion autorisieren, Video-Polling, das Genehmigungsverfahren zum Löschen –, was etwa 2,2 KB (office −878 B, computer −492 B, media −432 B, setup −424 B) von der Tool-Oberfläche entfernt, die in jedem Durchlauf gesendet wird. Die Skills pptx, xlsx und pdf tragen jetzt die Regeln, die nur im Schema lebten (ein Batch bekannter Operationen, `describe` nur für ein unbekanntes Feld, nicht vertrauenswürdige Dokumentinhalte), und der Skill computer-use gibt den Aufrufvertrag einmal an, statt jeden Schemasatz zu wiederholen.

- Browser Use braucht weniger Aufrufe pro Aufgabe. `click`, `fill`, `type`, `select`, `hover`, `upload` und `scroll` – sowie jedes Element von `fill.fields` und jeder `sequence`-Schritt – akzeptieren ein snapshotfreies `target` (`{role, name}`, `{name}` oder `{selector}`) statt eines `ref`: Der Host beobachtet die Seite selbst, handelt nur bei genau einem Treffer (mehrere Teilstring-Treffer werden zum einzigen wörtlichen aufgelöst), und ein mehrdeutiges Ziel scheitert mit den Kandidaten und ihren frischen Refs. `query` bei `snapshot`, `read` und `wait` gleicht durch Leerzeichen getrennte Schlüsselwörter mit OR ab (Treffer aller Schlüsselwörter stehen zuerst) und akzeptiert reguläre Ausdrücke als `/pattern/i`, und ein Filter ohne Treffer sagt, wie viele Elemente oder Zeichen er gefiltert hat. Transparente Steuerelemente oder solche mit pointer-events:none werden nicht mehr rundheraus abgelehnt: Eine versteckte Checkbox wird über ihr Label angeklickt, und die Eingabeziel-Schutzprüfung akzeptiert die Aktivierung des Labels. `fill` in einem `contenteditable`-Editor ersetzt den Inhalt als getippte Eingabe über ein Alles-auswählen, statt sein DOM zu überschreiben. Antworten vermerken „No observable change“, wenn eine Geste Dokument, URL und Steuerelementwerte unberührt ließ, `brief:true` listet nur Elemente auf, die seit der vorherigen Beobachtung neu oder geändert sind, Konsolenfehler werden einmal gemeldet, wenn sie neu sind, und eine bereits erfüllte Nachbedingung ist eine Warnung statt eines Fehlers. Snapshots markieren Dateieingaben mit `file-input`, `accept=…` und `multiple`; Ganzseiten-Screenshots verankern fixierte und Sticky-Elemente für die Aufnahme im Fluss; und Sitzungs-Cookies werden mit dem Schlüsselbund des Betriebssystems verschlüsselt gespeichert und beim Start wiederhergestellt, sodass Anmeldungen einen App-Neustart überstehen.

- Die Leisten über dem Prompt-Eingabefeld – Goal-Kapsel, Laufzeitfortschritt, Tool-Genehmigung, die Entwurfs-Kontextleiste und der Platz für die Durchlaufprüfung – leben jetzt in einem einzigen `ComposerDock`, und das Transkript wippt nicht mehr, wenn sich diese Leisten auflösen: Der Prüfplatz bleibt reserviert, solange der erste maßgebliche Worker-Lesevorgang eines Bereichs läuft, sodass ein Diff, der nach der Anzeige des Transkripts eintrifft, bestehende Geometrie füllt, statt den Viewport erneut zu verändern. Freigewordener Platz wird nie über einen Timer gehalten. Der Desktop-Host liest außerdem nicht mehr nach jedem akzeptierten Prompt eine ganze Sitzung neu (die Daemon-Log-Wiederherstellung „missing baseline“): Ein Antwort- oder Lane-Frame, der die Revision wiederholt, die die Projektion bereits hält, ist angewandter Zustand, keine gekreuzte Baseline. Ein-/Ausblend-Wechsel der Goal-Kapsel sind unter `MIXDOG_DESKTOP_PERF=1` zuordenbar.

- Eine Goal-Kapsel erscheint und verschwindet nicht mehr von selbst. Zwei Veröffentlichungspfade erzeugten das Blinken: Der 2-s-Routenpuls las den rohen Goal-Datensatz, während das Nutzereingabe-Archiv eines abgeschlossenen Goals noch geschrieben wurde, sodass die zurückgezogene Kapsel für einen Frame zurückkam; und unter Windows erschien ein Goal-Lesevorgang, der in den atomaren Dateiaustausch fiel (`EPERM`/`EACCES`/`EBUSY` oder der eigene laufende Schreibvorgang der Runtime), für diesen Frame als „kein Goal“. Routenveröffentlichungen lesen das Goal jetzt durch die Maske des Goal-Fortsetzungsarchivs, und der Goal-Speicher beantwortet solche Lesevorgänge aus dem zuletzt festgeschriebenen Datensatz.

- Browser Use hält nicht mehr für eine Genehmigung an: Der Desktop-Dialog „Einmal zulassen“, der `upload` und das gemeinsame `clear` von Cookie/localStorage schützte, entfällt, das Feld `confirm` verlässt den Browser-Tool-Vertrag, und der Skill browser-use lässt seine Freigaberegeln in der Unterhaltung weg. `MIXDOG_BROWSER_CONFIRM_ACTIONS` und `MIXDOG_BROWSER_DENY_ACTIONS` bleiben der einzige Weg, benannte Aktionen zu bestätigen oder abzulehnen.

- Die Lesespalte des Bereichs – Eingabefeld, Transkript und das Studio-Dock – wartet nicht mehr darauf, dass ein 1536px-Bereich breiter wird: Ab 768px hält sie 800px, bis der Bereich 1000px überschreitet, und folgt dann 80 % des Bereichs bis zur Obergrenze von 1000px bei 1250px, sodass Fenster mit 1536/1680 und 1920 mit geöffnetem Seitenpanel nicht mehr bei 800px hängen bleiben und ein Teiler, der die Stufe überquert, die Spalte nicht mehr um 200px einrasten lässt.

- Das Sitzungspanel beginnt mit zwei festen Starterzeilen, `New task` und `New Studio`, oberhalb der Sitzungsliste angeheftet. Studio verlässt damit die Aktivitätsleiste: Sein reiner Starter-Eintrag in der Leiste und die Starter-Ausnahmen im Seitenansichtslayout, im Pane-Dock und in den Dock-Umschaltern entfallen, und ein gespeichertes Leistenlayout verwirft beim Laden die ID `studio`.

- Das Ziel „Workflows“ der Aktivitätsleiste geht im Projekte-Panel auf: Eine Werkzeugleiste `Project | Workflow` – der Abschnittsschalter des Erweiterungs-Panels, jetzt als eine gemeinsame Komponente `SidebarSectionToolbar` geteilt – wechselt zwischen der Projektliste und den Workflow-Paketen, Standard-Agenten und Agentendefinitionen; das `+` in der Kopfzeile folgt dem Tab „Project“; `/workflow` und `/websearch` öffnen den Tab „Workflow“; und ein gespeichertes Leistenlayout verwirft beim Laden die ausgemusterte Ansicht `workflows`.

- Das Kit des Skills pptx erhält ein Designvokabular nach Art tokenbasierter Designsysteme: `palette()` leitet drei Linienstärken (`lineSubtle`, `line`, `lineStrong`) und vier Zustandsfarben (`T.state.positive | warning | critical | informative`, je als `solid` / `weak` / `text`, kontrastgarantiert und unter dem gesättigten Band des Reviewers gehalten, sodass eine Urteilsspalte nie `accent_hue_overuse` auslöst) ab; jeder Abstand liegt auf einer Abstandsleiter (`SPACE`), benannt nach Beziehung (`GAP.bind` / `within` / `between`, `GUTTER`, `PAD`, `M`); jede Textrolle trägt einen festen Zeilenabstand; die wiederkehrenden Träger (Badge, Callout, Chevron-Reihe, Kennzahl, Tabelle) lesen ihre Anatomie aus `SPEC` mit `tone`-Varianten, einer `stat`-Skalenstufe und einem Helfer `statBand()`; Symbole werden vier Größenbändern zugeordnet; und eine neue `references/writing.md` legt Regeln für Satz, Register, Zahl, Datum, Geld, Einheit und Übersetzungsspielraum fest, verlinkt aus den Skills docx und xlsx. Jeder Spec-Träger signiert seine Form, und der Kompositionsbeleg liest die Signaturen zurück (`slides[].specs`, `deck.specs`: Anzahl, Folien, Varianten, Anatomien), sodass ein Träger, dessen Schriftgröße oder Schnitt zwischen Folien abgewichen ist, als zweite Anatomie erscheint.

- Die Office-Designtokens leiten dieselben vier Zustandsfarben ab (`positive`, `warning`, `critical`, `informative`, jeweils mit einem `Weak`-Feld und einer `Text`-Stufe, kontrastgeprüft gegen Leinwand, helles Panel und Feld); die Entscheidungs-Gates von docx und xlsx zeichnen Release und Stop auf den Zuständen positive und critical statt mit einer literalen Tönung und dem zweiten Akzent, und das `calloutTone` eines `compose_document`-Abschnitts legt seinen Callout auf einen Zustand. Der Druckbereich eines `compose_sheet`-Dashboards folgt jetzt dem Entscheidungspanel, sodass ein Stop-Gate in einer Spalte jenseits der Leinwand nicht mehr von der gerenderten und exportierten Seite abgeschnitten wird.

## v0.9.161 - 2026-09-06

- Office-Audits messen Arial, Helvetica, Times New Roman, Courier New, Calibri, Cambria und Georgia in ihren metrikkompatiblen offenen Schnitten (Liberation, Arimo/Tinos/Cousine, Carlito, Caladea, Gelasio), wo das Original nicht installiert ist, statt die Schrift als nicht verfügbar zu melden und die Passung zu approximieren – ein Linux-Rechner mit den Liberation-Schnitten auditiert eine Präsentation jetzt wie Windows. Das Root-Paket erhält die Lanes `test:slow` und `test:live`, und die CI-Runtime-Lanes installieren die Liberation-Schnitte.

- Commits der Quellcodeverwaltung nehmen eine von Hand getippte Zusammenfassung plus eine optionale Beschreibung entgegen: Commit-Nachrichten-Vorlagen, Formatprüfungen, Autovervollständigung und KI-Generierung verlassen die Git-&-GitHub-Karte und das Commit-Formular, und die Legacy-Einstellungen `desktop.git` werden weder gelesen noch geschrieben.

- Computer Use verliert den einstellungsseitigen Autorisierungseditor (Fenster- und Aktionssperre, Ablauf): Es bleibt standardmäßig uneingeschränkt, mit den dauerhaften Schutzvorrichtungen – Eingabeschutz, Umgang mit Erhöhung, Nutzerübernahme, Umgebungsschutz –, und eine gespeicherte Autorisierungsdatei kann nicht mehr zu einer Aussperrung ablaufen. Prozessinterne Einschränkung bleibt für einen einbettenden Host über `MIXDOG_COMPUTER_POLICY_FILE` und `host.updateAuthorization` erhalten, nichts wird persistiert, und der Export der Fehlerdiagnose bleibt. Das Tool erhält `wait_for_user`: Übernimmt der Nutzer die Kontrolle, wartet das Modell ein begrenztes Intervall und erfasst danach frischen Zustand, statt Berechtigungen zu erraten.

- Jede Karte unter Erweiterungen und Built-in öffnet denselben Detaildialog – Identitätsplatte und Titel, Abschnitte in einem Rhythmus, eine Fußleiste mit der destruktiven Aktion links und ein einheitlicher Aktionsschaltflächenstil –, und die Hinzufügen-/Bearbeiten-Dialoge der Projekte schließen sich an. Die Karte Git & GitHub trägt das GitHub-Konto (gh-Anmeldung per Gerätecode); die Karte Lokaler Anbieter listet installierte Modelle mit Größe, Kontext und Laufzustand, einen Abschnitt „Modell laden“ für das Entladen im Leerlauf und Live-Fakten (Runtime-Build, GPU, freier Speicher, Server), während Reparatur und Verifizierung über den Skill local-provider chatgesteuert bleiben. Status-/Plattformfakten verlassen die Dialoge, weil das Kopfsteuerelement und das Listen-Badge sie bereits nennen. Die Erweiterungs-Stylesheets werden in `extension-list.css`, `extension-dialog.css`, `extension-editors.css` und `rail-controls.css` aufgeteilt.

- Goal: Das Fortsetzen eines pausierten Goals und der Start seiner genehmigten Aufgabe sind ein dauerhafter Schreibvorgang – `resume` akzeptiert Aufgabenaktualisierungen und -ergänzungen, das Markieren einer Aufgabe als `in_progress` setzt das Goal fort, und reine Buchführung gewährt nie eine Genehmigung. Der Zustand eines pausierten Goals erreicht das Modell, wenn die Anfrage vorbereitet wird, nach der Hydratisierung, statt als einmalige Erinnerung an der Antwort des Nutzers, sodass kein Durchlauf die Tatsache verlieren kann, dass ein Goal wartet.

- Smartphones synchronisieren ihre Ansichten bei der Wiederverbindung: Nach dem sicheren Handshake fragt der Browser den Desktop nach einer konsistenten Baseline seiner offenen Sitzungen (Snapshot, Sitzungsliste, Agent-Pool, Sitzungszustände), und Live-Veröffentlichungen werden zurückgehalten, bis sie eintrifft, sodass ein wiederverbundenes Smartphone kein veraltetes Transkript mehr zeichnet und das Ende eines Durchlaufs nicht verpasst. Das an Smartphones übergebene Transkript lässt Provider-Replay-Material in Deltas und Baselines gleichermaßen weg.

- Das Anlegen neuer Aufgaben übersteht eine unterbrochene Remote-Verbindung: Jede Anfrage trägt einen dauerhaften Beleg, sodass ein erneuter Versuch nach Zeitüberschreitung oder Wiederverbindung bei derselben reservierten Sitzung landet, statt ein Duplikat zu erzeugen, und der Watcher des Projektspeichers erholt sich selbstständig und gleicht den Katalog ab, solange er ausgefallen ist.

- Unterhaltungen und Tab-Leisten blenden ohne Sprung ein: Ein besuchtes Transkript erscheint, sobald seine sichtbaren Zeilen und der End-Offset über Frames hinweg übereinstimmen (begrenzt auf eine Sekunde, sodass Streaming oder eine langsame Schrift es nie verbirgt), und eine Tab-Leiste entscheidet über Überlauf anhand des Ziellayouts statt eines halb gewachsenen Tabs.

- Die Katalogaktionen des Lokalen Anbieters (`searchLocalProviderModels`, `inspectHuggingFaceModel`, `registerHuggingFaceModel`) existieren auf der Sitzungsoberfläche, auf der der Daemon sie auflöst, sodass ein über den Desktop geleiteter Setup-Aufruf nicht mehr als nicht verfügbare Sitzungsaktion scheitert.

- Die Sprachkataloge der Desktop-Oberfläche sind wieder im Gleichschritt mit dem Renderer: Zeichenfolgen, die die Source-Control-Ansichten und Slash-Befehle über `t()` lesen, fehlten in jedem Katalog (der Tab hieß auf Koreanisch „History“), die koreanischen Wendungen des ausgemusterten Legacy-Übersetzungspakets sind nach `ko.json` migriert, sodass dynamische Bezeichnungen („Ln 42“, „Callers of …“) wieder übersetzt werden, und die nativen Menü- und Dialogtexte werden aus denselben Katalogen generiert. Koreanisch ist vollständig; die anderen zehn Sprachen fallen für die neueren Wendungen auf Englisch zurück, bis sie übersetzt sind.

- Der Build des Browser-Importers ersetzt einen halb geschriebenen Upstream-Checkout unter TEMP, statt daran zu scheitern. Test-Harness: Renderer-Suites können Module importieren, die ein Feature-Stylesheet nachziehen (ein `.css`-Import wird unter Node zu einem leeren Modul), die Importprüfung des Daemons aus dem gebauten Artefakt läuft nach einem Build in der Live-Lane, und die Pfad-Fixtures des Einstellungsspeichers werden in der eigenen Pfadgrammatik des Hosts aufgelöst.

- Der Skill pdf und die Runtime übernehmen die Inspect-first-Disziplin der Referenz-PDF-Skills. Lesen: Ein Snapshot meldet `encrypted` und `passwordRequired` statt des eigenen Fehlers von pdf-lib, `open`/`snapshot` mit `password` lesen den Text einer gesperrten Datei für diesen Aufruf, ohne das Passwort zu behalten, jede Bearbeitung einer verschlüsselten Datei verweist auf `secure` → decrypt, Seiten tragen ihre Größe und Rotation, Lesezeichen kommen unter `outline` mit der jeweils geöffneten Seite zurück, und die Textextraktion (Office-Snapshots, Chat-Anhänge, das read-Tool) behält Zeilenenden als Zeilenumbrüche, sodass Absätze und Tabellenzeilen erhalten bleiben. Formulare: Felder legen den Typ `text|checkbox|radio|dropdown|optionlist`, `options`, `readOnly` und `multiline` offen, die ein Ausfüllen braucht; `fill_form` nennt ein unbekanntes Feld oder eine unbekannte Option zusammen mit dem Vorhandenen und meldet `filled`; `add_form_field` und `create` akzeptieren `optionlist`, `required`, `readOnly`, `maxLength` und `fontSize`; die Lint-Prüfung markiert eine zu kleine Box (`formIssues` bei create, `field_too_small` in `issues`); `preview_fields` schreibt eine Kopie, in der jedes Feld und jede vorgeschlagene Box umrandet und benannt ist, sodass ein Rendering die Platzierung vor dem Ausfüllen zeigt; ein Dropdown oder eine Liste mit koreanischen Optionen scheitert beim Erstellen nicht mehr, weil das Widget von Anfang an mit dem eingebetteten Schnitt gezeichnet wird; und ein mehrzeiliges Feld hat standardmäßig 11 pt statt der Autogröße von pdf-lib, die die erste Zeile riesig zeichnete und den Rest verwarf. Schriften: `create`, `add_text`, `watermark`, `fill_form` und OCR betten selbstständig eine installierte Unicode-Schrift ein, wenn der Text koreanisch, CJK, kyrillisch oder griechisch ist (`pdf-fonts.mjs`; `fontPath` wählt weiterhin; `detect` nennt den Schnitt als `portable.pdfUnicodeFont`). Schreiben: `create` bricht Prosa ohne Leerzeichen zeichenweise um, beachtet `\n`, bricht Tabellenzellen um und lässt Zeilen wachsen, wiederholt die Kopfzeile nach einem Seitenumbruch, nummeriert mehrseitige Ausgaben und akzeptiert `columnWidths`, Überschrift-`level`, Bild-`align`, `orientation`, `footer` und weitere Seitengrößen. Bearbeiten: `merge_pdf` nimmt `sources:[path | { path, pages, title }]`, `index` und `bookmarks:true`; `add_bookmark` schreibt einen Outline-Eintrag; `extract_pages` schreibt nach `output` und `split_pages` eine nummerierte Datei pro Seite oder pro `every` Seiten, ohne das Sitzungsdokument anzutasten; `extract_attachment` bildet eingebettete Dateien verlustfrei ab; `rotate_pages` addiert zur aktuellen Rotation; `delete_pages` behält eine Seite; `compress` meldet `bytesBefore`/`bytesAfter`; `add_text` nimmt `align:'center'|'right'` und nummeriert eine vorhandene Datei über `{page}`/`{pages}`; `highlight` markiert jeden Treffer von `find` (oder eine Box; `wholeWord`, `regex` und `first` grenzen ein) mit einer Multiply-Blend-Markierung, die den Text lesbar lässt; `add_link` legt einen unsichtbaren Link über einen Treffer, der eine URL oder eine andere Seite öffnet, oder lässt mit `urls:true` jede http(s)-Adresse im Text sich selbst öffnen; `stamp_image` passt sich innerhalb der Ränder ein, sofern keine Größe angegeben ist; `issues` meldet eine gescannte Seite nicht mehr doppelt und benennt aktive Inhalte (`active_content`: JavaScript, Launch, Aktionen beim Öffnen, Links zu Dateien oder anderen Nicht-Web-Schemata), ohne ihnen zu folgen. Analyse: `pdf-layout` mit `query` liefert nur die Treffer mit ihren Boxen; seine Textboxen folgen dem Lauf auf gedrehten Seiten und bei diagonalem Text, und es und der Snapshot melden `origin`, wenn eine Seitenbox nicht bei 0,0 beginnt. Markierungen durch `find` kehren die Anzeigetransformation um, um sowohl Ursprungsversätze als auch Seitenrotationen von 90/180/270 Grad zu handhaben, ohne das Dokument neu auszurichten; `first:true` bewahrt die Dokumentzeilenreihenfolge bei jeder Rotation. Das Layout listet die Links jeder Seite (`url` oder die Zielseite `page`) und ergänzt die Linien (`lines`) und `boxes` jeder Seite (kleine Quadrate mit der Markierung `checkbox`), was das Ausfüllen eines Formulars ohne Felder braucht; `pdf-tables` liest eine umrandete Tabelle aus ihren Zellrechtecken (`source:'ruled'`, umbrochene Zellen intakt) vor dem Raten der Textausrichtung (`source:'alignment'`) und schreibt pro Tabelle eine CSV, wenn `output:<dir>` angegeben ist, wie `pdf-images` PNG-Dateien schreibt und meldet, wo jedes Bild auf der Seite sitzt; OCR passt jedes unsichtbare Wort in seine Box ein, sodass die Textebene einzelne Leerzeichen behält. Seitenvorschauen (`render`, `qa`, `finalize`) geben pdf.js seine mitgelieferten Standardschriften, sodass eine in Helvetica oder Times gesetzte Seite nicht mehr mit Buchstabenabstand gerendert wird. Der Adapter ist in `pdf-writer`, `pdf-forms`, `pdf-draw` und `pdf-fonts` aufgeteilt, und der Skill wurde als inspect → create → edit → secure → verify neu geschrieben, mit der qpdf-Voraussetzung (PATH oder `MIXDOG_QPDF_PATH`), dem Vorbehalt zu Berechtigungsbits und der Grenze für Text an Ort und Stelle.

- Der Skill xlsx und die Runtime übernehmen die Modellierungsdisziplin, die ein Leser von einer Tabellenkalkulation erwartet: Ein backend-neutrales Formel-Audit (geteilt von portablem `issues` und der Qualitätsprüfung) meldet für jede Arbeitsmappe einen nicht in Anführungszeichen gesetzten Blattverweis mit mehreren Wörtern, eine Verknüpfung zu einer externen Arbeitsmappe, einen als Ganzzahl gespeicherten Prozentwert, ein Jahr mit Tausendertrennzeichen und eine als Text gespeicherte Zahl (dazu als Information ein langes Blatt mit nicht fixierter Kopfzeile und eine Tabellenspalte mit Zahlen unter Standard), und unter `auditProfile:'financial-model'` einen Inline-Satz in einer Formel, eine ungeschützte Division, eine einzelne Formel, die das Zeilen- oder Spaltenmuster bricht, einen einzelnen Verweis über die befüllte Ausdehnung des Blatts hinaus (der Off-by-one, der sauber neu berechnet), eine Hartkodierung in einer Formelzeile und Eingaben, die von Formeln nicht zu unterscheiden sind, außerdem eine Eingabe, die eine Formel liest und die keine Quellennotiz trägt, und einen Abgleich auf dem Prüfblatt, der FALSE ergibt – auf beiden Backends, da das `issues` von Excel das gemeinsame Audit jetzt in die eigenen Befunde des Hosts einfließen lässt. Snapshots legen Zahlenformat, Schrift, Farbe und Füllung jeder formatierten Zelle offen (die BGR-Ganzzahlen von Excel werden auf dieselbe RRGGBB-Form normalisiert), Legacy-Notizen pro Zelle und pro Blatt, Excel-Tabellen pro Blatt (Datensätze darin sind Daten, die die Tabelle belegt, sodass das Audit nur bei Annahmen außerhalb eine Notiz verlangt), verbundene Bereiche und fixierte Bereiche in der Form von Excel, Wahrheitswerte als Wahrheitswerte, den `defaultStyle` der Arbeitsmappe und eine Zusammenfassung `document.conventions` (Standardschrift, verwendete Schriften, Zahlenformate pro Spalte, Eingabemarkierungen, Beispieleingaben), sodass eine Bearbeitung den eigenen Konventionen der Datei folgen kann; `set_formula` setzt die mehrwortigen Blattnamen, die die Arbeitsmappe enthält, in Anführungszeichen (und auf beiden Backends jeden mehrwortigen Namen vor `!` und einem Verweis) und meldet die `normalizedFormula`, die LibreOffice-Neuberechnung liefert einen `status` mit `totalErrors`, eine `errorSummary` nach Fehlertyp und Zelle sowie die `unparsedFormulas`, die LibreOffice in Kleinbuchstaben zurückgeschrieben hat, und `finalize` weist eine Arbeitsmappe zurück, bei deren Neuberechnung ein Fehler gefunden wurde, selbst wenn die Prüfung übersprungen wurde. Der Skill schreibt seine Regeln um null Formelfehler, Formeln statt eingefügter Ergebnisse, wörtliche Vorgaben, dokumentierte Annahmen, die Ausfüll-Legende und das Anpassen an die Konventionen einer bestehenden Datei neu, mit `references/model-conventions.md` für Farben, Zahlenformate, Struktur, das Prüfblatt und Quellenangaben.

- Der Skill pptx beginnt mit einer Routentabelle – eine neue Präsentation ist ein `author`-Skript, eine bestehende `open` → `snapshot` → `batch`, und Lesen ist ein seitenweiser `snapshot` oder der Quellextraktor – und löst seine Skriptpfade über `${MIXDOG_SKILL_DIR}` auf, sodass die Seiten-QC, der unabhängige Reviewer und `source-extract.mjs` (in den Skill verschoben, mit Test) aus jedem Projekt laufen. Der Bearbeitungsabschnitt nennt die Fallstricke, die die Runtime tatsächlich hat: Eine duplizierte Folie teilt sich ihren Diagramm-Part mit ihrer Quelle, Vorlagendekoration bleibt dort, wo die Zeilenzahl des Platzhalters sie hingesetzt hat, und ein Skript, das sein eigenes `pres` deklariert, erbt die 10 × 5,625-Zoll-Leinwand von pptxgenjs. Die Skills docx, xlsx und pdf ergänzen die Auslöser, die Nutzer tatsächlich schreiben („Word“, „Excel“, „PDF 읽어“, „PDF 만들어“), und der Skill docx sagt, wie ein Snapshot einen Zeilenumbruch zeigt.

- Die portable PowerPoint-Bearbeitung löst das Beziehungsziel eines Diagramms so auf, wie es das Paket tut: pptxgenjs schreibt es als absoluten Part-Namen (`/ppt/charts/chart1.xml`), was `set_chart_data` und die anderen Diagrammoperationen auf einer erstellten Präsentation früher als fehlenden Part meldeten. Portable Snapshots behalten Zeilenumbrüche und Absatzenden jetzt als Zeilenumbrüche – Form- und Notiztext einer Präsentation sowie Absatz-, Zellen-, Kommentar-, Revisions-, Notiz- und Inhaltssteuerelement-Text eines Word-Dokuments – statt „4주차“ und „잔존율“ aneinanderzureihen.

- Tab-Leisten der Bereiche animieren Hinzufügen und Schließen im gemeinsamen Animationstakt der Benutzeroberfläche: Ein neuer Tab wächst aus dem Nichts, während seine Nachbarn schrumpfen, sodass die Reihe die Leiste nie überläuft und zurückgleitet, und ein geschlossener Tab klappt an Ort und Stelle zusammen, während die übrigen in seinen Platz gleiten, statt zu springen. Ein zu seiner Sitzung beförderter Entwurf wird weiterhin sofort getauscht, und die Leiste verwirft ihren ungenutzten Breiten-Haltezustand.

- Das Office-Authoring erhält drei Strukturen für die Ausgabequalität: `author` und `batch` liefern ein gemessenes `audit` (Passung, Grenzen, Kontrast, Abstand, Paket) mit Zählungen pro Folie und einem Auftrag zur Behebung im selben Durchlauf, der seine Runden zählt; `author` weigert sich, eine Präsentation abzulegen, deren Zahlen keine Tatsache dahinter haben (`facts_gate`), es sei denn, das Briefing deklariert `facts: sample`, was einen Hinweis auf illustrative Zahlen durch qa und finalize trägt; und der Skill pptx liefert `scripts/qc-pages.mjs`, einen Fixer pro Seite, der pro Folie eine frische Sitzung nur mit dem office-Tool laufen lässt und deren Arbeitskopie nur übernimmt, wenn die gemessenen Mängel der Seite nicht gewachsen sind und keine andere Folie sich geändert hat.

- Skills teilen ihre Listenzeile in eine einsätzige Beschreibung und einen `when_to_use`-Auslöser; die Skill-Liste des Modells zeigt `description — trigger`, bei 250 Zeichen gekappt, der Skill-Editor erhält ein separates Feld „Auslöser“, der Validator von skill-creator warnt, wenn eine Listenzeile gekürzt wird, und jeder eingebaute Skill wurde in die neue Form umgeschrieben.

- Die Goal-Insel der Sitzung richtet ihre Aufgabenliste an der eingeklappten Kopfzeile aus, trennt Zeilen mit Haarlinien und klappt bei einem Klick außerhalb oder Escape zusammen.

- Die Smartphone-Oberfläche folgt dem Desktop-Chrome: Die Kontextanzeige sitzt neben dem Modellauslöser des Eingabefelds, die Symbole der Werkzeugleiste gehören zur lucide-Familie, und das rechte Sheet öffnet sich als eine Dock-Einheit, deren Kopfzeile dieselben Ansichtsumschalter trägt wie die Desktop-Leiste.

- Eingebaute Skills werden aus einer gebündelten Skill-Quelle ausgeliefert, und die Office-Anleitungen werden zu den Skills pptx, docx, xlsx und pdf, die an die Funktion gebunden sind, die sie steuern. Die Einstellungen gruppieren abhängige Skills, MCP-Server und Hooks unter ihrem Plugin oder eingebauten Feature.

- Office erstellt PPTX-Präsentationen aus pptxgenjs-Skripten mit Designleitfaden, Hilfskit, Layoutmenü und modellgeführter visueller QA und toleriert Abweichungen in der Reihenfolge von Präsentations- und Diagramm-Kindelementen.

- Tool-Aufrufe wandeln JSON-Text-Argumente in die deklarierte Schemaform um, einschließlich interner Registry-Schemas.

- Browser Use teilt URL-, Tab-, Partitions-, Schwärzungs- und Snapshot-Skript-Richtlinien in eigene Module auf; Computer Use verfeinert das Overlay-Modell, das Eingabe-Backend und die Sitzungskoordination.

- Desktop-Boot-Warmup, Wiederherstellung des Seiten-Docks, Zeitpunkt der Nutzungsrücksetzung, Bridge-eigene Discovery-Dateien und die Wiederherstellung des Sitzungstransports halten Kaltstarts und Wiederverbindungen reaktionsschnell. FastDirect-Deploys wärmen die installierte Runtime vor.

- Der Test-Runner trennt schnelle, langsame und Live-Stufen mit Zeitberichten; Sitzungsspeicher cachen Transkriptzusammenfassungen und Listen-Sweeps; Hilfsfunktionen für Provider-Anfragen härten die Wire-Behandlung von Anthropic, Cursor und OpenCode.

## v0.9.160 - 2026-09-02

- Die TUI installiert ihre gepatchte Ink-Runtime jetzt aus einem versionierten Release-Asset. Produktions-Builds, Frame-Harnesses und Lastsonden lösen das installierte Paket auf und bewahren dabei das eigene Cursor-, Auswahl- und Render-Verhalten.

- Der Desktop-Start zeigt jetzt nutzbare Bereichsrahmen, bevor die langsamere Hydratisierung von Katalog und Runtime abgeschlossen ist. Browser-, Terminal-, Editor- und Seiten-Dock-Oberflächen werden unabhängig wiederhergestellt, wobei fokussierte Bereitschaftssonden und zurückgestellte Host-Dienste Kaltstarts reaktionsschnell halten.

- Browser Use und Computer Use haben jetzt rollenbasierte Host-Module statt flacher Monolithen. Browser-Aktionen teilen sich explizites Routing, Gast-Lebenszyklus und Antwortverträge mit stärkerer Behandlung von Dateiauswahl und Dialogen, während Computer Use Discovery, Beobachtung, Eingabe, Sitzung, Overlay und Backend-Zuständigkeiten mit erweiterter Sicherheitsabdeckung trennt.

- Office-Runtime-Module sind nach den Rollen Core, Design, Quality, Portable, PDF, COM und Benchmark organisiert. Freiform-Komposition, referenzgesteuerte Layoutauswahl, erstellte PowerPoint-Szenen und gerenderte Absicherungsprüfungen verbessern die visuelle Qualität, ohne bearbeitbare Ausgabe oder Transaktionsgrenzen zu schwächen.

- Anthropic-OAuth-Sitzungen erfahren jetzt eine vom Anbieter verlangte Mindestversion der CLI, speichern nur sichere Aufwärts-Updates und wiederholen die abgelehnte Anfrage einmal, ohne eine explizite Versionskonfiguration zu überschreiben.

## v0.9.159 - 2026-09-01

- Die Windows-Release-Abnahme prüft jetzt das kanonische Einstellungsinventar mit 16 Einträgen statt der veralteten Anzahl vor der Navigation.

- Computer Use koordiniert jetzt Vordergrund-Ziel-Leases, erfasst nach Fensterübergängen neu, validiert begrenzte Aktionssequenzen und stellt ein Overlay für die Nutzerübernahme bereit. Pfade für Aufnahme, Tastatur, Zielauswahl und Wiederherstellung sind in fokussierte Module aufgeteilt, mit breiterer Host- und Bridge-Abdeckung.

- Browser Use erhält sitzungsbezogene Registries und dauerhafte Oberflächen pro Unterhaltung. Browser-, Diff- und Hilfsansichten können am Seiten-Dock jeder Unterhaltung angehängt bleiben, während lokale Dateilesevorgänge den ausgemusterten doppelten Ordner-Explorer-Pfad ersetzen.

- Die Komprimierung mit frischem Kontext trägt jetzt eine begrenzte Memory-Übergabe, bewahrt die Fortsetzung des aktiven Durchlaufs und den Zustand der Tool-Hülle und hält die Cache-Layouts des Anbieters über die Komprimierung hinweg stabil. Die Memory-Aufnahme projiziert das komprimierte Transkript konsistent, statt sich auf den ausgemusterten Fast-Track-Pfad zu stützen.

- Die Präsentationserstellung in Office ergänzt kreative Ausrichtung, Layout-Grammatik, semantischen visuellen Fluss, eine Review der gerenderten Ästhetik und einen Release-Qualitätswert, sodass die Ausgabe abwechslungsreicher wird und schwache Komposition früher auffällt.

- Der Aufwand für Verifizierung und Release-Infrastruktur sinkt deutlich: Der 3.500 Zeilen lange Tool-Smoke-Monolith ist jetzt in vierzehn fokussierte `node --test`-Suites unter `scripts/tool-contracts/` aufgeteilt, wobei fragile Prüfungen auf exakten Wortlaut zu Schlüsselphrasen-Verträgen gelockert wurden, die CI-Pfadauswahl hat in `scripts/release-paths.mjs` eine einzige Quelle für das Release-Gate und die Deploy-Planung, und ein Release führt die kritische Lane nicht erneut aus, wenn das Gate exakt dieselben Commits bereits verifiziert hat.

- Keine Suite kann mehr unbemerkt verrotten: Die verbleibenden Test-Monolithe (provider-toolcall, session-transport, shell-hardening) sind Suites pro Domäne unter `scripts/`, das Release-Gate führt bei jedem gegateten Push die Tool-Contract- und Kompaktierungsverträge (recall-fasttrack) aus, und ein wöchentlicher `suite-health`-Sweep führt jedes registrierte `test:*`-/`smoke:*`-Skript über einen Opt-out-Katalog aus und eröffnet bei einem Fehler ein verfolgtes Issue.

## v0.9.158 - 2026-08-31

- Der Erweiterungs-Hub bietet für Git, Memory, Browser Use, Computer Use, Office und Sprache jetzt einen einheitlichen Ablauf für Installation, Fortschritt, Aktivieren und Deaktivieren. Optionale Runtimes werden bei Bedarf vorbereitet, Office kann LibreOffice über den Paketmanager der Plattform installieren, und das Deaktivieren der Sprache bewahrt heruntergeladene Assets.
- Das Desktop-Runtime-Packaging ist kleiner und deterministischer: Optionale Feature-Nutzlasten bleiben außerhalb der Basis-App, Runtime-Code wird einmal vorbereitet, Snapshot-Deploys tolerieren gleichzeitige Bearbeitungen, und die Release-CI teilt sich einen plattformübergreifenden Runtime-Build mit expliziten Git- und Computer-Use-Gates.
- Studio bewahrt Entwürfe pro Element und macht Detailbearbeitung, Auswahl und Tastaturinteraktionen über Navigationen hinweg robust. Auch die Steuerelemente für Kontextnutzung und Sprachdiktat melden ihren aktuellen Zustand einheitlicher.
- Die OpenAI-OAuth-Route lässt das WebSocket-Prompt-Prewarming standardmäßig aus und vermeidet so eine unnötige Aufwärmanfrage, sofern es nicht ausdrücklich aktiviert wird.
- Terminal-Bench 2.1 veröffentlicht den vollständigen `k=5`-Vergleich mit Codex CLI samt rohen Harbor-Artefakten, Quell-Commit-Verifizierung, Herkunft der wiederhergestellten Kosten und reproduzierbarer Berichtserzeugung.

## v0.9.157 - 2026-08-31

- Browser Use erhält eine kleinere, zuverlässigere Host-Aufteilung über Tabs, Downloads, Interception, Berechtigungen, Snapshots, Dialogberichte und Seiten-Lebenszyklus. Der Chromium-Profilimport umfasst jetzt die Offline-Entschlüsselung von App-Bound-v20-Cookies über den gepackten nativen Importer, ohne entschlüsselte Geheimnisse dem Renderer oder Agenten preiszugeben.
- Computer Use ist in begrenzte Module für Aufnahme, Discovery, Zielauswahl, Beobachtung, Eingabe und Worker zerlegt. Fairere Ressourcenzuordnung, frischerer Zustand nach Aktionen, strengere Eingabeschutzvorrichtungen und erweiterte Wiederholungsszenarien machen lang laufende native und Chromium-Sitzungen schneller und sicherer.
- Memory wechselt zu einer kompakten E5-Embedding-Runtime mit inkrementellem Backfill (neueste zuerst), Cache-Kompression und -Aufbewahrung, koreanisch-bewusstem lexikalischem Ranking und Rückgewinnung inaktiver Worker. Das alte native Token-Addon und der schwerere Legacy-Modellpfad werden aus der ausgelieferten Runtime entfernt.
- Die Sitzungswiederherstellung erhebt das Checkpoint-Journal zur dauerhaften Wiederaufnahmegrenze und bewahrt Anbieternutzung, Komprimierungsanker, Recall-Übergabe und das Thinking-Replay von Anthropic über Unterbrechung, Wiederholung und Neustart, ohne Kontext zu duplizieren.
- Das Office-Authoring ergänzt vom Modell verfasste Kompositionspläne, eine wiederverwendbare Designbibliothek, Dokumentvorschau und breitere portable Word-, Excel- und PowerPoint-Primitive, bei Beibehaltung der strukturellen und gerenderten Absicherungsprüfungen.
- Desktop- und mobile Web-Oberflächen erhalten Remote-Browser-Use, Share-Target-Aufnahme, Push-Benachrichtigungen, umfangreichere Dokumentbearbeitung und -vorschau, ruhigere Wiederherstellung beim Start und besser vorhersehbare Service-Worker-Cache-Updates.
- Die native Suche begrenzt jetzt breite Inventar-Leases und lässt gleichzeitige find-, glob- und grep-Arbeit fair zu. Die Release-Automatisierung baut geänderte native und Sprach-Assets inkrementell neu, verifiziert gepackte Sidecars und verwendet unveränderte Plattform-Runtime-Artefakte wieder.

## v0.9.156 - 2026-08-29

- Das portable Office-Authoring erhält Diagrammrendering und Textmetriken, sodass mehr PPTX- und XLSX-Arbeit ohne Übergabe an den Office-COM-Host abgeschlossen wird.
- Die Tool-Verträge von Browser Use und Computer Use werden gemeinsam mit dem Desktop-Einstellungsspeicher, der IPC-Validierung und der Tool-Formatierung im Transkript überarbeitet.
- Das virtuelle Scrollen des Desktops folgt jetzt den Upstream-Paketen, und das Festhalten am unteren Ende des Transkripts stützt sich auf die eigene Scroll-Zurückstellung des Kerns.
- Entwicklungs-Deploys können aus einem eingefrorenen Snapshot des Arbeitsbaums laufen (`update:dev:snapshot`), wodurch eine Installation gelingt, während andere Sitzungen das Repository weiter bearbeiten, statt an der Eingabe-Fingerprint-Prüfung zu scheitern.

## v0.9.155 - 2026-08-29

- Der Import von PPTX-Folien, der Austausch von Bildern und die Erstellung von Tabellendaten laufen jetzt in der portablen Engine, sodass diese Operationen den Office-COM-Host nicht mehr benötigen.
- Das Office-Authoring erhält portable Module für Packaging, Komposition, Tabellenstil und Folienformen hinter der bestehenden Absicherungs- und Qualitätspipeline.
- Das Goal-Tracking erhält Erinnerungs- und Textextraktionsbehandlung für Fortsetzungen, und der Desktop hält Sitzungsmetadaten synchron, mit einem begrenzten Renderer-Cache-Budget für den Zustand ungelesener Sitzungen.

## v0.9.154 - 2026-08-29

- Computer-Use-Sitzungen werden auf jedem Exit-Pfad freigegeben, statt von einem unref'd Timer abzuhängen, den eine scheidende Runtime nie auslöst: Das Herunterfahren von Daemon und Worker gibt sie frei, eine schließende Sitzung gibt ihre eigene frei, inaktive Host-Worker laufen auf derselben Uhr ab wie die Fensteransprüche, die sie halten, und eine unterbrochene Client-Verbindung bricht laufende Eingaben ab, statt sie den Desktop bis zur Befehls-Zeitüberschreitung steuern zu lassen. Der Client versucht es außerdem einmal erneut gegen eine neu veröffentlichte Bridge, sodass ein Neustart der Desktop-App den nächsten Befehl nicht mehr rundheraus scheitern lässt.
- Eine abgestürzte Browser-Use-Seite erholt sich beim nächsten Befehl, statt ihn fehlschlagen zu lassen. An das tote Dokument gebundene Refs werden mit ihm verworfen, sodass die Wiederherstellung nie Koordinaten einer Seite zurückgeben kann, die nicht mehr existiert.
- Eine Komprimierung, die zwischen einem Prompt und der Anbieteranfrage läuft, hängt nicht mehr, wenn die Memory-Runtime stockt: Der Memory-Aufruf recall-fasttrack ist für jeden Aufrufer begrenzt, nicht nur für den einen Pfad, der zufällig eine Zeitüberschreitung eingebaut hatte.
- Der Parser für versteckte Einträge des Windows Explorers zerlegt die Ausgabe von attrib.exe auf jedem Host nach Windows-Pfadregeln, und die Fähigkeitsprüfung des Commit-Hooks funktioniert jetzt über Git-Versionen hinweg, die sich uneins sind, ob ein nicht nativer Hook-Name ein Flag braucht.
- Deploy baut byte-identische Plattform-Runtimes nicht mehr neu. Testquellen verlassen sowohl das veröffentlichte Paket als auch den Runtime-Cache-Schlüssel, sodass eine reine Teständerung den Cache der vorbereiteten Runtime trifft, statt einen siebenminütigen Windows-Neubau zu zahlen. Desktop-Suites laufen als parallele Gate-Jobs, einschließlich eines Windows-Zweigs, der Computer Use endlich in der CI ausführt, und die 240 Sekunden lange Git-Suite liegt nicht mehr im standardmäßigen lokalen Lauf.

## v0.9.153 - 2026-08-28

- Windows Computer Use führt jetzt eine kleinere Beobachtungsschleife im CUA-Stil aus: Kompakte Barrierefreiheit und ein einfacher Screenshot werden standardmäßig gemeinsam zurückgegeben, der Zustand nach Aktionen wird sofort aktualisiert, AX und OCR-Fallback teilen sich ein striktes Elementbudget, unbrauchbare schwarze, weiße oder nicht passende Aufnahmen geben nie einen Koordinatenrahmen aus, Mutationen machen frühere Pixelrahmen ungültig, ein neues Popup im selben Prozess wird zum deterministischen Verifizierungsziel, app-eigene Electron-Textfelder nutzen renderer-natives Einfügen im Hintergrund, die Wiederherstellung nennt eine nächste Eskalationsstufe, und gefährliche sitzungsbeendende Tasten, Shell-Nutzlasten oder Starts von Shell-/Skript-Hosts werden an der Host-Grenze blockiert. Ein Windows-Dashboard mit 23 Szenarien deckt jetzt native, Electron-, Chrome-, koreanische OCR-, Zweitdisplay-, Veraltungs-, Fokus-, Popup-, Sicherheits- und Bereinigungspfade ab.
- Beobachtungen und Durchläufe von Computer Use sind schneller, ohne die Eingabegrenze zu schwächen: leichtgewichtige Win32-Übergangs-/Frame-Snapshots, exakte Fensteraufnahme, begrenzte moderne Chromium-Barrierefreiheit, adaptives Start-Polling, Aufnahme-Ressourcenschutz und verifizierte Fokus-/Cursor-Wiederherstellung ersetzen wiederholte vollständige App-Enumeration und unbegrenzte Fallbacks. Elementgezieltes wörtliches Tippen kann in einer Aktion fokussieren und tippen, und begrenzte OCR kann in die obligatorische Aufnahme nach der Aktion einbezogen werden. Die abschließende Matrix aus 23 Szenarien × 10 Quell-Hosts erreichte 230/230 semantische Erfolge und senkte die Basis-p50/p95-Szenariolatenz um 90,55 %/94,01 %; eine separate Stressmatrix mit dichten/minimierten/veralteten Zielen bestand 40/40. Alle 30 redundanten Neuaufnahmen nach Aktionen wurden entfernt, und die Aufrufe sanken in den fünf bündelbaren Aktions-Workflows um 36,84 %. Beliebiges Bündeln von Mutationen bleibt nicht unterstützt.
- Computer Use bietet jetzt einen strikten Vertrag mit 15 Aktionen statt 28 überlappender Aktionen oder eines flachen Schemas mit optionalen Feldern. Beobachtung/Suche/Zoom nutzen `capture`, der Lebenszyklus von Fenster und Zwischenablage nutzt Operationsfelder, und ein gemeinsames `capture_after`-Objekt konfiguriert die automatische Verifizierung. Referenzorientierte Hinweise verlangen frische exakte Ziele, bevorzugen semantische Elemente und halten Browser Use getrennt. Das endgültige Schema umfasste vor den Frontier-Erweiterungen geschätzte 2.644 Tokens; der Frontier-Vertrag vor der Entfernung bestand 36/36 Erstaufruf-Modellszenarien. Der aktuelle Direct-Dispatch-Vertrag umfasst geschätzte 3.210 Tokens und 14.485 Wire-Bytes. Das schreibgeschützte `diagnose` meldet die Windows-OCR-/UIA-Bereitschaft ohne Bildschirmpixel; die begrenzte `sequence` stoppt bei einem Fehler oder Zielübergang und liefert einen abschließenden frischen Zustand; strikte Aufruf-Kardinalität verhindert parallele zielübergreifende Mutationen sowohl in der Modellführung als auch vor dem Eager-Dispatch der Runtime. Zusätzliche `computer`-Aufrufe im selben Durchlauf werden nicht ausgeführt und erhalten einen Wiederherstellungsfehler mit frischem Zustand. Die Auswahl in natürlicher Sprache bestand 4/4 sichere Fokusketten und 4/4 Übergangsgrenzen. In 10 Wiederholungen nutzte eine Fortsetzung mit zwei Aktionen 50 % weniger modellseitige Aufrufe und Aufnahmen, bei um 12,34 %/32,31 % gesunkener p50/p95-Latenz. Modellseitige Bestätigungsabfragen von Computer Use und Transaktionsgenehmigungen von Office wurden entfernt; vom Nutzer angeforderte Aktionen werden direkt ausgeführt, während blockierte Tasten-, Nutzlast- und Skript-Host-Muster harte Fehler bleiben. Die gemessene Anbieternutzung beträgt 5.150 Eingabe-Tokens und 4.026 ms p50 pro Modellaufruf. Ein Schema mit 12 Aktionen nach der Beobachtung senkte die Eingabe um 18,16 % bei 27/27 Genauigkeit, wurde aber verworfen, weil wiederholte Latenz-Ausreißer und Schemaänderungen mitten in der Schleife den Vertrag des unveränderlichen Anbieter-Präfix-Caches brechen würden. Semantische Aktionen mit deterministischen exakten Fensterübergängen melden jetzt bestätigte Verifizierung. Es bleibt kein Legacy-Aufrufform-Fallback. Nach einem Entwicklungs-Deploy bestätigte die Validierung der installierten App, dass das linke `click(ref)` semantische Aktivierung nutzt und dass ein nativer Start über Dateizuordnung sein ausgewähltes Ziel mit frischem Zustand zurückgibt; Markierungen und Koordinaten bleiben explizite Zeigeroperationen.
- Browser Use kann Chromium-Passwörter, -Cookies und -Verlauf importieren, nur maskierte Konten für den aktuellen HTTPS-Ursprung vorschlagen und ein ausgewähltes Anmeldeformular innerhalb einer isolierten CDP-Welt ausfüllen, ohne das gespeicherte Passwort dem Renderer, dem Agenten, der Diagnose oder den Protokollen preiszugeben. Utilities nutzt jetzt standardmäßig den ersten Tab auf der rechten Seite, migriert die alte Standardplatzierung, ohne benutzerdefinierte Layouts zurückzusetzen, und enthält den Browser-Einstiegspunkt.
- FastDirect erstellt jetzt Fingerprints, Staging, Backup und atomare Wiederherstellung der nativen Browser-Import-Sidecars zusammen mit `runtime.asar`, sodass inkrementelle Entwicklungsupdates die installierte App nie ohne ihren Importer zurücklassen können.
- Die Kontextnutzung der Sitzung erfasst jetzt einen kanonischen Snapshot nach der Komprimierung, der Persistenz und Neustart übersteht, bis der nächste Durchlauf ihn ungültig macht. Goal-Zustand und Komprimierungswiederherstellung bleiben über neu gestartete Dienste konsistent, statt veraltete Token-Nutzung neu zu zeichnen oder wiederaufnehmbare Arbeit zu verlieren.
- Die Office-Erstellung teilt sich jetzt ein semantisches Inhaltsmodell, strukturelle und gerenderte Absicherungsprüfungen, Prompt-Injection-Review, Checklisten-Gates und eine Polier-Pipeline über Word, Excel und PowerPoint. Steuerelemente für Seite/Ansicht von Tabellen, Auswahl nach Vorlagenkapazität, native Persistenz von Diagrammdaten und Live-Verifizierung durch Speichern und Wiederöffnen stärken Dokumente in Release-Qualität.

## v0.9.152 - 2026-08-27

- Der Goal-Modus kann jetzt ein lang laufendes Ziel über Durchläufe hinweg tragen, mit dauerhaften Abschlussbedingungen, Steuerelementen zum Pausieren und Fortsetzen, Zeitlimits, automatischer Fortsetzung, modellseitigen Verwaltungs-Tools und einer sitzungsbezogenen Desktop-Statusinsel.
- Browser Use und Windows Computer Use sind als optionale eingebaute Fähigkeiten verfügbar. Browser Use kann Seiten in der App oder im Hintergrund inspizieren und bedienen, während Computer Use UI Automation, Screenshots, Tastatur-, Zeiger-, Scroll- und Fensteraktionen mit DPI-bewusster Eingabe und Schutzvorrichtungen kombiniert.
- Die Anbieterwiederherstellung bewahrt jetzt die ursprüngliche Reihenfolge von Reasoning, Text und Tool-Aufrufen über Anthropic-, Gemini-, OpenAI- und kompatible Streams hinweg, einschließlich Wiederholungen, hängender Durchläufe, gespeicherter Sitzungen, Remote-Projektion und Komprimierung.
- Die Komprimierung beginnt eine frische Read-Cache-Epoche, nachdem sie das Transkript verändert hat, und bestehende Sitzungen synchronisieren neu verfügbare Runtime-Tools an Durchlaufgrenzen, statt einen veralteten Tool-Katalog zu behalten.
- Desktop- und mobile Navigation sind sauberer und vorhersehbarer: Mobile Neustarts beginnen mit einer einzigen „New task“, während Wiederverbindungen die aktuellen Bereiche behalten, Bereichswischgesten funktionieren über reichhaltige Inhalte und Overlays hinweg, und Seitenseiten, Erweiterungen, Markdown, Statusbezeichnungen und nachgestellte Aktionen teilen sich engere responsive Layouts.

## v0.9.151 - 2026-08-26

- Das Bearbeiten eines symbolischen Links ändert jetzt die Datei, auf die er zeigt, statt abgelehnt zu werden: patch und edit folgen dem Link in jeder Engine, schreiben atomar neben dem echten Ziel und lassen den Link selbst intakt.
- Headless- und Benchmark-Läufe hinterlassen keine temporären Datenbanken und Prozesse mehr. Jeder Lauf erhält eine isolierte Runtime-Wurzel, das Herunterfahren wartet auf den Sitzungs-Daemon, statt Erfolg vor ihm zu melden, und verwaiste Cluster werden beim Beenden bereinigt.
- Die Unterhaltungskomprimierung behält alles, was sie behalten soll. Automatische, manuelle und geleerte Komprimierung teilen sich einen Pfad, die gespeicherte Zusammenfassung steht vorn mit dem vollständigen Rohverlauf dahinter, und die jüngsten Durchläufe überleben wörtlich, statt durch eine Zeilen- oder Größenobergrenze gekürzt zu werden.
- Die Exploration liest die Originaldatei, bevor sie entscheidet, wie sie sie parst, zählt oder zusammenfasst, sodass keine Formatvermutung mehr die Antwort bestimmt.
- Desktop-Feinschliff: Angehängte Bilder öffnen sich im System-Viewer, die Kontingentzeilen des Nutzungspanels lesen sich in natürlicher Reihenfolge, und Kontext- und Routenpanels verlieren ihre übrig gebliebenen Rahmen und Fokusumrisse.
- Die Ergebnisse von Terminal-Bench 2.1 werden aus einem `k=5`-Lauf aller 89 Aufgaben neu veröffentlicht, wobei die rohen Verifizierungsartefakte jedes veröffentlichten Laufs zusammen mit den Harness- und Metrikskripten eingecheckt sind.

## v0.9.150 - 2026-08-25

- Tool-Ergebnisse bleiben überschaubar und ehrlich in Bezug auf ihre Größe: Suchausgaben und Mehrdatei-Lesevorgänge halten ein festes Budget, statt eine Antwort mit Tausenden Zeilen zu fluten, und ein Pfad, der schlicht nicht existiert – oder ein gewöhnliches Urteil über den Repository-Zustand –, kommt als Antwort zurück statt als Fehler, der den Assistenten in die Wiederherstellung schickt.
- Sitzungen tragen über einen Neustart hinweg keinen veralteten Anbieter-Fingerprint mehr, und eine neue Nachricht weckt sofort einen Durchlauf, der auf einen Hintergrund-Task wartet, sodass eine Antwort ankommt, statt hinter dem Warten zu hängen.
- Die Textauswahl im Terminal erholt sich von einem Ziehen, dessen Taste außerhalb des Fensters losgelassen wurde, und eine über den oberen oder unteren Rand hinaus gezogene Auswahl folgt dem normalen Verhalten für Zeilenanfang und Zeilenende, statt in der letzten vom Zeiger gehaltenen Spalte einzufrieren.
- Die Sprachdiktat fragt vor der Installation ihrer Runtime um Bestätigung, Tool-Karten und Diff-Frames richten sich am gemeinsamen Theme aus, und zehn Oberflächensprachen wurden aufgefrischt.

## v0.9.149 - 2026-08-24

- OpenAI-OAuth-Sitzungen sprechen standardmäßig die Wire-Form des Referenz-Clients: stabile Installations- und Thread-Identität, die leichtere Anfrageform bei aktuellen Modellen und anbieterkorrekte Behandlung eines Sockets, der mitten in der Sitzung sein Lebensdauerlimit erreicht.
- Der Sitzungsstart reserviert seine vorgewärmte Verbindung nur dann für den ersten Durchlauf, wenn der vorgewärmte Prompt noch übereinstimmt, sodass ein Durchlauf, dessen Umgebung oder Tool-Oberfläche sich geändert hat, sauber startet, statt die ganze Anfrage erneut zu senden.
- Verzeichnislisten liefern eine für das Überfliegen bemessene erste Seite statt eines Dumps, und Code-Strukturabfragen holen vollständige Symbolkörper nur dann, wenn die genaue Implementierung gebraucht wird.

## v0.9.148 - 2026-08-24

- Desktop- und mobile Unterhaltungen bewahren Entwürfe, Verlauf, Folgeverhalten, Bereichsgesten und Remote-Zustand zuverlässiger und senken gleichzeitig die Relay-Übertragung und den Aufwand beim Renderer-Deployment.
- Agentensitzungen stellen Anbieter-Streams, Komprimierung, Worker-Zustand und Tool-Ergebnisse einheitlicher wieder her, mit klareren Git-Konflikt- und Umgebungsergebnissen und genauerer Such-Telemetrie.
- Die Spracheingabe erhält einen verifizierten plattformübergreifenden Runtime-Release-Pfad, während Memory-Abruf, native Prozessbehandlung und die Vorbereitung der gepackten Runtime gehärtet werden.
- Release-Automatisierung, FastDirect-Deployment und Benchmark-Berichte verwenden unveränderte Artefakte jetzt wieder und vergleichen Modellaufrufe, Kosten und finalen Kontext mit anbieterkorrekter Abrechnung.

## v0.9.147 - 2026-08-21

- Lange OpenAI-Sitzungen halten ihre Antwortkette und die Turn-State-Anheftung jetzt über Wiederverbindungen, Elementumordnung und Komprimierung hinweg intakt, sodass der Anbieter-Präfix-Cache eine Sitzung übersteht, statt mitten in der Aufgabe neu zu starten.
- Der Sitzungsstart wärmt das Anbieter-Präfix vor und trennt Umgebungsdetails vom gemeinsamen Anweisungspräfix, was Kaltstarts und das wiederholte Hochladen identischen Kontexts verringert.
- Regeln zur Tool-Nutzung sind bei gleichen Garantien kürzer: Routing-Klauseln verschwinden jetzt mit den Tools, die sie nennen, und Shell-Ergebnisse werden von dem Runner klassifiziert, der sie erzeugt hat.
- Desktop-Tool-Karten und Ergebniszusammenfassungen sind lokalisiert, und die Kontextanzeige meldet die Schätzung nach der Komprimierung statt des verworfenen Präfixes.
- Benchmark-Läufe erhalten schnelle Routenvoreinstellungen und einen Referenzadapter für die grok-CLI, sodass Referenzzahlen aus denselben Containern und demselben Verifier stammen.

## v0.9.146 - 2026-08-21

- Mobile Web-Unterhaltungen halten Touch-Scrolling, Messung von gestreamtem Markdown, Tab-Wischgesten, kompakte Eingabesteuerelemente und responsive Overlays jetzt über native Gesten, Drehung und Layouts kleiner Bildschirme hinweg stabil.
- Sitzungen können eine vollständige Unterhaltung in das aktuell gewählte Modell mitnehmen, wenn sie in dessen Kontextgrenze passt, während Kontextnutzung und geerbte Routendetails explizit bleiben.
- Tool-Gruppen im Transkript bewahren ihre ursprünglichen Aufrufe, Argumente, Ausgaben und den Abschlusszustand für die detaillierte Inspektion, mit lokalisierten Bildvorschauen und klarerer Darstellung der Aktivität.

## v0.9.145 - 2026-08-21

- Mobile Websitzungen halten nativen Viewport-Maßstab, Kopplungswiederherstellung, Remote-Zustandsprojektion und Transkript-Scrolling jetzt über Touch-Gesten, Zeilenmessungen beim Streaming, App-Wiederherstellungen und langsame Verbindungen hinweg stabil.
- Desktop-Bereiche, Source-Control-Aktualisierungen, Tool-Aktivität, Befehlsoberflächen und Sitzungszustand erholen sich einheitlicher, bei Erhalt responsiver Layouts und klareren Feedbacks zu Laden oder Unterbrechung.
- Das Tool-Routing der Agenten wendet jetzt engere Argumentschutzprüfungen, Git-Mutationsrichtlinien, Anbieter-Präfix-Behandlung, Evidenzprojektion und Shell-Ausgabe-Wiederherstellung über die gemeinsame Runtime und die TUI hinweg an.
- Release-, Benchmark-, Lokalisierungs- und Diagnose-Tooling validieren ihre Verträge jetzt mit breiterer Regressionsabdeckung und kompakteren Runtime-Berichten.

## v0.9.144 - 2026-08-21

- Die Desktop-Interaktion folgt Tastatur- und Zeigerfokus zuverlässiger, verbessert mobile Bereichswischgesten sowie die Darstellung von Transkript/Status und meldet den Zustand von Shell-Hintergrund-Tasks mit sichererer Wiederherstellung.
- Git-Diff-Bereiche zeigen ihren eigenen Ladezustand sofort an, fassen sich überlappende Aktualisierungen zusammen und rendern Repository-Text, ohne konfigurierte externe diff- oder textconv-Befehle aufzurufen.
- Solo ist jetzt der Standard-Workflow, Regeln zur Tool-Nutzung bewahren Evidenz und bündeln Arbeit enger, und begrenzte read-/grep-Fenster verringern unnötigen Kontext, ohne die Paginierung zu verbergen.

## v0.9.143 - 2026-08-20

- Die Sitzungsausführung teilt sich jetzt einen überwachten Runtime-Worker statt eines Prozess-Shard-Pools. Hintergrund-Agenten bleiben im Prozess, Anbieter-Wartezeiten geben ihren lokalen CPU-Zulassungsslot ab, und rechnerweite Spawn-Limits und die Wiederherstellung der Runtime-Gesundheit bleiben durchgesetzt.
- Geräte-Genehmigungen für Remote erscheinen nur, solange Einstellungen → Verbindung geöffnet ist, stellen ausstehende Anfragen beim Öffnen dieses Panels wieder her und werden erst abgeschlossen, nachdem der Browser seine authentifizierte E2EE-Verbindung nachgewiesen hat.

## v0.9.142 - 2026-08-20

- Das Linux-Desktop-Packaging validiert die Zielarchitektur in dem ABI-Prebuild-Verzeichnis, das `node-pty` tatsächlich lädt, während kompilierte Windows- und macOS-Pakete ihren `build/Release`-Validierungspfad behalten.

- Installierte Web-Apps nehmen eine ausstehende Desktop-Genehmigung über Neuladungen hinweg wieder auf, während der Desktop veraltete Abfragen ersetzt, sie mit der Relay-Anfrage ablaufen lässt und jede Entscheidung erst akzeptiert, nachdem der Dienst sie bestätigt hat.
- FastDirect verwendet frische Build-Ziele, einen persistenten Produktions-Renderer-Cache, vorbereitete Runtime-Ausgaben und eine extrahierte ASAR-Shell-Vorlage wieder. Live-Relay-Deploys erstellen unabhängig Fingerprints für Renderer-/Server-Änderungen und laden nur verifizierte Renderer-Deltas hoch, bevor der atomare VPS-Austausch erfolgt.
- Inline-Code folgt der Schrift und Größe des umgebenden Textes und behält als einzige Inline-Unterscheidung die Farbe, während Fenced Code monospaced bleibt.

## v0.9.141 - 2026-08-20

- Die Desktop-Aufgabenerstellung funktioniert unter Electron 41 und Node 24: Der Agent-Shard-Router kopiert unveränderliche ESM-Exporte des Sitzungsmanagers in eine beschreibbare Fassade, bevor er seine Remote-Sitzungs-Überschreibungen installiert.

## v0.9.140 - 2026-08-20

- Studio-Löschungen greifen beim ersten Klick: Ein beendeter Lauf gibt seinen Rasterplatz frei, sobald sein Asset indiziert ist, sodass das Löschen dieses Assets den Platz nicht mehr als Phantom-Kachel „generating“ wiederbelebt. Die Galerie ist nicht mehr auf 2.000 Einträge begrenzt – ein Asset verlässt den Speicher nur durch ein explizites Löschen –, und ein Lauf, der fehlschlägt, ohne Job startet oder seinen Runtime-Snapshot verliert, meldet das jetzt, statt stillschweigend zu drehen.
- Der mobile Tab-Umschalter liest sich als Kartenraster und erhält erst dann ein Filterfeld, wenn die Liste lang genug ist, um eines zu brauchen, während das Smartphone-Chrome die Eingabe-Scheiben, die Statusinsel und die Panel-Sheets in Touch-Proportionen neu fasst und nur beim Hovern sichtbare Steuerelemente in Reichweite bringt.
- Eine installierte Web-App kann sich selbst koppeln: Sie öffnet eine geräteweitergeleitete Einstiegs-URL, bittet diesen Desktop hinter einem zweistelligen Code, der auf beiden Bildschirmen steht, um Genehmigung und erhält Kopplungsmaterial, das an ihren eigenen Wegwerfschlüssel versiegelt ist. Gekoppelte Browser registrieren jetzt, welche Push-Lanes sie lesen, sodass ein verbundenes Smartphone nicht mehr für Terminal-, Editor- und Dateiverkehr zahlt, den es nie anzeigt.
- Der Suchserver des Code-Graphen bedient Clients an gemeinsamen Pipes mit Antwortwarteschlangen pro Verbindung und clientbezogenen Anfrage-IDs und beendet sich nach einem Leerlauffenster selbst, sodass ein hart beendeter Eigentümer keine warmen Server mehr zurücklässt.
- Tool-Aufrufe überstehen Rauschen in Anbieterargumenten: Ein ausgelassener optionaler Basispfad wird zum aktuellen Projekt aufgelöst, statt den Aufruf scheitern zu lassen, Task-Argumente werden auf die gewählte Aktion eingegrenzt, und Git-Ausgaben behalten ihren letzten Fortschrittsframe und ihre abschließende fatal-Zeile, statt den Grund unter Redraw-Frames zu begraben.
- Der Renderer lädt einen UI-Sprachkatalog statt elf, legt die Sprache fest, bevor das erste App-Modul ausgewertet wird, und lädt beim Auswählen einen Oberflächen-Chunk vor; /inherit überträgt eine bestehende Unterhaltung in eine neue Sitzung auf der aktuell gewählten Route.
- Die Namensnennung von Drittanbietern erfolgt allein durch LICENSES und NOTICE.

## v0.9.139 - 2026-08-20

- Antigravity OAuth kommt als Anbieter: Eine Google-Anmeldung stellt Gemini 3.x und Claude über das Cloud-Code-Assist-Gateway bereit, wobei Anmeldung, Token-Aktualisierung und Endpoint-Failover der bestehenden OAuth-Anbieterform folgen.
- Agenten haben jetzt genau zwei Zustände, ein festgelegtes Modell oder aus, und die Websuche löst das Hauptmodell auf, wenn ihre Route nicht gesetzt ist.
- Gekoppelte Browser erreichen die Desktop-Operationsoberfläche – Projektanweisungen, Ordnernavigation und Orte sowie den Git-Vertrag – über ein gemeinsames Argumentvalidierungsmodul, während der Relay-Sitzungszustand als clientbezogene kompakte Deltas in binären E2EE-Frames reist.
- Die Web-App liefert jetzt vorkomprimierte brotli- und gzip-Assets aus, hält Hintergrund-Warmups und Schriften auf getakteten oder langsamen Verbindungen zurück, skaliert Bildanhänge und Diktat-Audio vor dem Upload, lässt den Live-Blur der angehefteten Statusinsel auf Smartphones weg und zeichnet den Markenakzent in Google-Blau.
- Das Runtime-Staging und Asar-Packing unter Windows überstehen Repo-Lifecycle-Skripte und vorübergehende Dateisperren durch Virenschutz, und die Statuszeile der TUI berechnet die Zahl laufender Shells direkt auf dem Sofortpfad.

## v0.9.138 - 2026-08-19

- Remote-Websitzungen nutzen jetzt clientbezogene Abonnements, binäre E2EE-Frames, kompakte Zustands-/Katalog-Deltas, Terminal-Batching und Paint-Latenz-Sonden, was das Übertragungsvolumen verringert und die Live-Wiederherstellung auf langsamen Verbindungen bewahrt.
- Das Scrollen im Web-Transkript und die Eingabe im Composer bleiben bei gleichzeitigen Remote-Snapshots, Sitzungswechseln und mobilem Rendering visuell stabil.
- Runtime-Kontext, Wiederherstellung von Anbieteranfragen, Hintergrund-Task-Benachrichtigungen und Wiederherstellung von Abschlüssen sind über lang laufende Sitzungen hinweg gehärtet.

## v0.9.137 - 2026-08-19

- Die Wiederherstellung bei Remote-Wiederverbindung aktualisiert jetzt Sitzungskataloge und eingehängte Transkript-Lanes, und das Update-Steuerelement führt die Schaltflächengruppe der Titelleiste an.

## v0.9.136 - 2026-08-19

- Die ausgemusterte Discord-/Telegram-Messaging- und Kanalsitzungs-Infrastruktur wird entfernt, während mobile Systemleisten durchgehend schwarz bleiben.

## v0.9.135 - 2026-08-18

- Der Desktop bewahrt jetzt Bereichslayouts, Seitenleistenzustand, Panel-Geometrie und Eingabeentwürfe über Neuladungen und FastDirect-Neustarts hinweg, mit erweiterter Renderer-Regressionsabdeckung.
- Die Shell-Ausführung härtet jetzt das Bereinigen der Umgebung, den Warm-Standby, die Wiederherstellung von Hintergrundabschlüssen, die native Prozessbehandlung und das Tool-Routing in interaktiven und Headless-Sitzungen.
- Native Spawn-Linux-Releases sind statisch gelinkt, Graph-Suche und Recall-Berichte sind gehärtet, und das Terminal-Bench-Routing sowie die Berichts-Tools wurden aktualisiert.

## v0.9.134 - 2026-08-17

- Der Desktop liefert jetzt die gewählte Wortmarke aus, einen einheitlichen Modellrouten-Editor mit Modellparametern und persistierter Listenreihenfolge und entpackt node-pty neben dem gepackten Daemon.
- Die Sitzungskomprimierung ist nach Eigentümer fest gesperrt: Agentensitzungen bleiben semantisch, Nutzersitzungen verwenden recall-fasttrack. Die Einstellungen listen Core-Erinnerungen nicht mehr auf (sie leben am Projekt), und das Windows-Abnahmeinventar stimmt überein.

- Anbieter- und Tool-Integrationen umfassen jetzt den OAuth-Lebenszyklus und die Token-Wiederherstellung über Anthropic, Cursor, Grok und OpenAI, die Grok-spezifische Normalisierung von Tool-Schemas und das zerlegte Pfad-/Muster-Fan-out von Suche und grep.
- Sitzungsorchestrierung und TUI-Workflows erzwingen jetzt die Bindung an die Eigentümersitzung, bewahren abgeschlossene Übergabe- und Hintergrundabschluss-Karten über Wiederherstellungen hinweg, behalten ausgelagerte wartende Prompts bei und klassifizieren Ergebnisse über Befehlsfehler, Tool-Fehler und harmlose Fehltreffer hinweg.
- Die Desktop-Workspace-Navigation bewahrt jetzt die Sitzungstitel der Bereiche bei Ziehinteraktionen, ergänzt Wiederholungsversuche bei der Kaltstart-Wiederherstellung des Workspace, die abgebrochene Tabs verhindern, und aktualisiert die Onboarding- und Fähigkeitskonfigurationspanels.

## v0.9.133 - 2026-08-16

- Die reine Anbieter-Evidenzprojektion legt jetzt wiederholte typisierte Dateipfade innerhalb von Mutationsepochen als Aliasse an, bewahrt exakte Tool-Hüllen und rekonstruierbare Pfade und verringert den kumulativen Kontext in langen Sitzungen.
- Die Git-Ausführung teilt sich jetzt eine Mutationsrichtlinie über Orchestrierung und Evidenzprojektion, serialisiert repositoryweite Schreibvorgänge gegenüber Dateibearbeitungen, nutzt baumeigene native Prozesse und macht wartende Sperren abbrechbar.

## v0.9.132 - 2026-08-16

- Die Tool-Ausführung legt jetzt den vollständigen Shell-Exit-Status offen, ergänzt eine dedizierte Git-Oberfläche, stärkt die atomare Patch-Erstellung und die Diagnose und verbessert die Integrität von Suche, Listen, Code-Graph und nativem Graph unter gleichzeitiger Last.
- Sitzungskomprimierung, Anbieter-/Bildwiederherstellung, Evidenzverfolgung, Shard-Gesundheit und die Lead-Runtime-Bereinigung bewahren jetzt Zustand über Fehler hinweg, ohne degradierte Worker zu verdecken oder unnötige Fallback-Arbeit auszulösen.
- Desktop-Routing, Agentenaktivität, wiederhergestellter Bereichszustand und gestreamtes Markdown-Rendering bleiben in Live- und fortgesetzten Unterhaltungen jetzt reaktionsschnell und visuell konsistent.

## v0.9.131 - 2026-08-14

- Release-Gates laufen jetzt automatisch mit inkrementeller Pfadauswahl, Desktop-Plattform-Runtimes werden vor dem Packaging vorbereitet, native Graph-Builds nutzen ein schnelleres reproduzierbares Profil, und das Produktions-Deployment von Web/Relay umfasst atomares Rollback sowie Hash- und Gesundheitsverifizierung.
- Desktop-Release-Lanes packen jetzt, sobald ihre passende Runtime bereit ist, Compiler-Caches des Graphen bleiben zwischen Reproduzierbarkeits-Builds isoliert, Relay-Installationen sind per Lockfile festgelegt, und das Release-Timing warnt bei Regressionen von 10 %.
- Die Agentenbereinigung hält Projektionen des Lead-Pools nicht mehr für Child-Worker, sodass das Entsorgen einer anderen Runtime weder die aktive Desktop-Unterhaltung schließen noch eine akzeptierte Folgenachricht verwerfen kann.

## v0.9.130 - 2026-08-14

- Die Anbieter- und Sitzungswiederherstellung klassifiziert vorübergehende Stream-Fehler jetzt einheitlich, wiederholt von Bildern abgelehnte Durchläufe, ohne die Nutzerabsicht zu verlieren, und bewahrt Unterbrechungs-, Zusammenfassungs- und Endergebniszustand über Gemini- und OpenAI-Transporte hinweg.
- Tool-Fehler werden ohne Verschmutzung durch Test-Traces persistiert, die Shell-Richtlinie vermeidet Fehlalarme bei in Anführungszeichen stehenden Skripten, und native Pfade für Suche/Lesen/Listen/Stat teilen sich abbrechbare Arbeit, wobei frische Watcher-Invalidierung und das Verhalten von grep/glob auf exakte Dateien unter Last erhalten bleiben.
- Desktop-Studio, Nutzung, Agentenaktivität, Bereichslayout, Lokalisierung und die Darstellung der Worker-Tags bleiben in wiederhergestellten und Live-Sitzungen jetzt aufeinander abgestimmt.

## v0.9.129 - 2026-08-14

- Headless exec läuft jetzt standardmäßig auf einer echten Solo-Oberfläche: Websuche und Memory-Tools bleiben aus, es sei denn, --web-search / --memory schalten sie wieder ein, Shell-Kindprozesse erben einen erzwungenen No-Egress-Proxy (Loopback bleibt erreichbar), und die Umgebungszeile der Sitzung nennt network=offline, damit Modelle nie versuchen, auf das Web zuzugreifen.

## v0.9.128 - 2026-08-14

- Erkundungs-Tools enden jetzt in der Suchrunde: grep verwendet sein Ausgabebudget für gerankte Quellblöcke (Treffer seltener Zweige zuerst), find verwirft reine Rausch-Fuzzy-Ergebnisse, und code_graph-Symbol-Outlines filtern vor dem Kappen und beachten Body-Anfragen.
- Die Agentenführung bündelt einen bestgeleiteten Aufruf pro Unbekannter statt spekulativer Multi-Tool-Fächerung, was den Token-Verbrauch im Benchmark um ein Drittel senkt, ohne dass sich die Bestehensquote ändert.
- Härtung der Sitzungswiederherstellung und der Runtime-Resilienz bei nativer Suche, Shell-Vertrag und read-/list-Tooling.

## v0.9.127 - 2026-08-14

- Native Binärdateien haben jetzt eine einzige kanonische Heimat in GitHub Releases: npm liefert nur die CLI aus, während CLI-Läufe Assets bei Bedarf verifizieren und cachen und Desktop-Builds dieselben verifizierten Plattform-Assets einbetten.

## v0.9.126 - 2026-08-14

- Die native Suche behandelt jetzt den vollständigen internen grep-/find-Vertrag, bewahrt Regex-Wiederherstellungsfehler und überlappt die Suche des ersten Durchlaufs mit dem Code-Graph-Warmup.

## v0.9.125 - 2026-08-13

- Shell- und Hintergrund-Task-Ausführung nutzen jetzt einen hash-fixierten nativen Prozessmanager unter Windows, Linux und macOS, ohne Fallback über Umgebung, lokalen Build, Dateiregister, Standby-Shell oder Node-Prozess.
- Native Pfade für Suche, Patch, Download, Medien, Recall, Webhook und Sitzung erzwingen jetzt begrenzte Ressourcen, strengere Eigentümerschaft sowie gehärtete Transport- und Release-Lieferketten-Prüfungen.
- Die Extraktion der Memory-Runtime akzeptiert jetzt verifizierte Links innerhalb des Archivs, weist aber weiterhin Traversal, externe Links und spezielle Tar-Einträge zurück.
- Das Verhalten von Desktop-Projekt, Terminal, Update, Remote-Kopplung, Relay und Bereichen enthält jetzt die konsolidierten Sicherheits-, Wiederherstellungs- und Responsive-Layout-Korrekturen.

## v0.9.124 - 2026-08-12

- Die Desktop-Agentenaktivität gruppiert jetzt jede aktive Sitzung unabhängig vom fokussierten Tab, wiederhergestellte Sitzungsbereiche wärmen korrekt vor, und bestehende Sitzungen akzeptieren Folgeeingaben, ohne auf die Bestätigung des Hosts zu warten.
- Der Sitzungstransport von Desktop und Daemon übersteht jetzt Start-Wettläufe, veraltete Steuersitzungen, vorübergehenden Socket-Verlust und Stream-Wiederherstellung an Ort und Stelle, während die Remote-Eigentümerschaft über Sitzungsfokuswechsel hinweg global bleibt.
- Die Git-Commit-Einstellungen trennen jetzt das sichtbare Beispiel von den KI-Anweisungen, serialisieren sich überlappende Speicherungen und validieren und korrigieren die Ausgabe im Conventional-Commit-Format, bevor sie akzeptiert wird.
- Core Memory spiegelt kuratierten und generierten Kontext jetzt in eine atomare, revisionsgeschützte Datei, sodass Sitzungen Memory mit Geltungsbereich laden können, ohne die Memory-Runtime kalt zu starten, wobei Mutationen den Spiegel aktualisieren.
- Die Transkriptverankerung der TUI und die Behandlung der Escape-Auswahl vermeiden visuelle Sprünge und versehentliche Wiederherstellung der Warteschlange, während der Refusal-Fallback von Terminal-Bench dem Beendigungsgrund der Runtime auch nach gestreamter Erzählung folgt.

## v0.9.123 - 2026-08-12

- Die Anbieter-Einrichtung im Desktop stellt veraltete Steuersitzungen jetzt wieder her, ohne rohe Transportfehler preiszugeben, und der Prompt-Verlauf greift nur bei einem leeren Entwurf.
- Die Pfadsuche vermeidet kalte Vollbaum-Sweeps, fasst Watcher-Prewarms zusammen und verschärft native Suchfristen, Bulk-Nebenläufigkeit und Prozess-Snapshots.
- Die Hinweise zum Timeout asynchroner Shells unterscheiden jetzt unbegrenzte Hintergrundarbeit von expliziten Kill-Fristen.

## v0.9.122 - 2026-08-11

- Die Regeln für das Tool-Routing zentralisieren jetzt Pfadkonventionen, entfernen doppelte Batching-Hinweise und verlangen eine schreibgeschützte Inspektion nur, wenn Evidenz gefährdet ist.
- Der Anthropic-Benchmark-Preflight löst Anbieter-Importe jetzt korrekt aus isolierten temporären Harness-Snapshots auf.

## v0.9.121 - 2026-08-11

- Die Regeln zur Tool-Ausführung und die Shell-Diagnose unterscheiden jetzt eindeutige Pfad-Fehltreffer, vertrauen verifizierten Hüllen, behalten Wertprüfungen im selben Durchlauf bei und machen Command-not-found-Fakten aus stderr sichtbar.
- Die Transkript-Virtualisierung des Desktops hält jetzt die Endpunkte der nativen Textauswahl während des Autoscrolls beim Ziehen fest, während Hilfs-Starter Symbol und Text in inhaltsbemessenen Zeilen ausrichten.

## v0.9.120 - 2026-08-11

- Shell-Hintergrund-Tasks behalten jetzt ihre Eigentümersitzung und ihren Daemon, nachdem jede Ansicht sich gelöst hat, sodass das Entfernen im Leerlauf den Task nicht abbrechen kann, bevor sein Abschluss zugestellt wurde.

## v0.9.119 - 2026-08-11

- Native Reproduzierbarkeits-Builds für Graph und Token laufen jetzt parallel auf unabhängigen Runnern, während sich die DMG- und ZIP-Uploads für macOS Intel überlappen und hängende Übertragungen zügig abbrechen.
- Desktop-Projektnavigation, Hilfsoberflächen, Transkriptfokus und das Verhalten der mitgelieferten Virtualisierung werden zusammen mit strafferen Tool-Ausführungsstilen und Dateisystem-Prozesswiederverwendung verfeinert.
- Die Anhangsbehandlung für Discord und Telegram bewahrt die begrenzte Medienzustellung und validiert das Upload-Verhalten von Telegram direkt.

## v0.9.118 - 2026-08-11

- Der Desktop konsolidiert Agenten, Suche und Source Control im Hilfs-Dock, hält Utilities beim Starten von Tools ausgewählt und gleicht die Behandlung von Warnung gegenüber Fehler bei wiederhergestellten und Live-Tool-Karten an.
- Dateilisten und native Suche fassen jetzt gleichzeitige Enumeration zusammen, unterstützen abbrechbare persistente Anfragen und Prozess-Snapshots und bewahren das begrenzte Fallback-Verhalten bei starkem Dateisystem-Fan-out.
- Code-Graph-Batching, PowerShell-Standby-Wiederverwendung, Shell-Prozessbaum-Verfolgung und Cache-Invalidierung sind gegen gleichzeitige Arbeit und veralteten Zustand gehärtet.

## v0.9.117 - 2026-08-11

- Die Prompt-Übermittlung im Desktop unterstützt jetzt das sofortige Einreihen per Enter und die präzise Wiederherstellung von ausstehendem Text und Anhängen per Esc, während das Transkript-Scrollen Virtualizer-Korrekturen während aktiver Leserbewegung zurückstellt.
- Die Desktop-Utilities zeigen jetzt direkte Starter für Studio, Terminal und Explorer mit lokalisierten Beschreibungen, während die Aktivitätsleiste die kreative Utilities-Identität und eine aufgefrischte Nutzungsdarstellung verwendet.
- Veraltete modellseitige Kanalaktionen und ihre Anbieter-Dispatch-Infrastruktur werden entfernt, sodass der beworbene Tool-Katalog mit der Runtime-Oberfläche übereinstimmt.
- Die Hinweise zur Tool-Ausführung straffen gebündelte Evidenz und Verifizierung im selben Durchlauf, während gleichzeitige Dateisystem-, Graph-, Patch- und Shell-Schübe eine begrenzte Behandlung von Threadpool, Spawn-Lane und Erreichbarkeitsdruck erhalten.

## v0.9.116 - 2026-08-11

- Die Terminal-Bench-H5-Rundenanalyse ergänzt belohnte Task-Traces und aggregierte Rundenzahlen für den abschließenden Vergleich bei hohem Aufwand.

## v0.9.115 - 2026-08-11

- Die Terminal-Bench-H4-Rundenanalyse erfasst erfolgreiche Task-Sonden bei hohem Aufwand und deren Rhythmus aus Abruf, Patch und Verifizierung.
- Die Hinweise zur Tool-Ausführung behandeln Aufgabenfakten und bewiesene Prüfungen jetzt als dauerhaft bekannten Zustand und halten die Patch-Verifizierung im selben Ausführungsdurchlauf.

## v0.9.114 - 2026-08-11

- Erratene Tool-Identitäten werden jetzt vor abhängigen Aufrufen verifiziert, mit einer H3-Terminal-Bench-Rundenanalyse, die die daraus entstehenden Abrufmuster festhält.

## v0.9.113 - 2026-08-11

- Die Tool-Hinweise bündeln jetzt unterschiedliche Evidenzproben und vermeiden redundante Aktivierung zurückgestellter Tools oder Projekte, wobei die Terminal-Bench-Rundenanalyse verbleibende serielle Sondenmuster erfasst.

## v0.9.112 - 2026-08-11

- Desktop-Oberflächen für Utilities, Aktivität, Transkript, Einstellungen und Repository werden um fokussierte Feature-Konfiguration und kompakte Regressionen vereinfacht.
- Anbieterwiederherstellung, Shell-/Listen-Diagnose und Release-Verifizierung werden in kleinere, für den Versand kritische Suites konsolidiert, ohne ihre Transport-, Asset- oder Packaging-Verträge zu schwächen.

## v0.9.111 - 2026-08-11

- Die Repository-Navigation nutzt jetzt die direkte eingebaute Tool-Oberfläche ohne separaten Explorer-Agenten, was Routing-Aufwand und Legacy-Konfiguration verringert.
- OpenAI-WebSocket-Wiederholungsentscheidungen bewahren aktuelle Auth-, Drosselungs- und Abbruchfehler, während die Wiederherstellung des Sitzungstransports und die Deduplizierung von Abschlüssen gehärtet werden.
- Tool-Batching, Graph-Fan-out, Fortschrittsberichte sowie das Verhalten von Desktop-Transkript, Einstellungen und Hilfs-Dock werden mit fokussierten Regressionen verschlankt.
- Terminal-Bench-2.1-Profile, fortsetzbare Läufe, unveränderliche Harness-Snapshots und Kostenabrechnung werden für reproduzierbare native Vergleiche verschärft.

## v0.9.110 - 2026-08-11

- Anbieter-Transporte begrenzen jetzt Nicht-Stream-Stillstände bei Anthropic, unterscheiden wiederholbare Transportfehler von Modellverweigerungen, bewahren die Reasoning-Kontinuität von OpenAI bei der Wiederherstellung und wärmen kompatible WebSocket-Sitzungen vor.
- Die Tools patch, list und shell beheben eindeutige Pfad- oder Kontextabweichungen in einem Aufruf, behalten aber die Schutzvorkehrungen gegen Mehrdeutigkeit, Symlinks und destruktive Befehle bei.
- Die Vervollständigung von Sitzungstiteln und der Markdown-Quell-Fallback sind widerstandsfähiger, mit fokussierten Regressionen für Anbieter, Renderer, Tools und Routing.
- Die Diagnose von Terminal-Bench 2.1, faire native Baselines, Nutzungsabrechnung und reproduzierbare Experimente zum Reasoning-Replay werden erweitert.

## v0.9.109 - 2026-08-10

- Shell-Befehle, die mit einem Exit-Code ungleich null enden, werden als Befehlsergebnisse statt als Tool-Fehler behandelt, mit konsistentem Status in Runtime und TUI.
- Tool-Routing, Explorer-Limits, Output-Style-Verträge und ihre Regressionssuites werden verschärft, um redundante Arbeit zu vermeiden und dabei knappe Berichte für Nutzer zu bewahren.
- Compact-Patch-Wurzeln legen jetzt sowohl die Schreibgrenze als auch das relative Pfadkoordinatensystem fest, einschließlich klarerer Wiederherstellungshinweise.

## v0.9.108 - 2026-08-10

- Das Compact-Patch-Parsing akzeptiert ältere Begin/End-Wrapper um Compact-Abschnitte und lässt kanonische V4A-Eingaben unverändert.

## v0.9.107 - 2026-08-10

- Nicht interaktive Automatisierungs- und Benchmark-Sitzungen verwenden ausdrücklich den impliziten Genehmigungskontext, während interaktive Workflows ihr Nutzer-Genehmigungs-Gate behalten.

## v0.9.106 - 2026-08-10

- MCP-Clients, Tool-Discovery, Anweisungen, Ausführung, zurückgestellte Aktualisierung und Abbau sind nach Runtime-Geltungsbereich isoliert, sodass gleichnamige Server nicht zwischen gleichzeitigen Sitzungen oder eigenständigen Agenten durchsickern können.

## v0.9.105 - 2026-08-10

- Remote-Zugriff erfolgt nur noch über die Web-App: Das ausgemusterte Capacitor-/Android-Paket, APK-Download-Routen, Native-Shell-Hooks und die Versionsverdrahtung des mobilen Releases werden entfernt, während das Relay-Deployment einen expliziten Renderer-Staging-Schritt erhält.
- Tool-Aufrufe normalisieren Eingaben für das aktuelle Projekt jetzt zu kompakten relativen Pfaden, weisen nicht passende oder redundante Geltungsbereiche einheitlich zurück und wahren Parität über die Verträge von Shell, Patch, Graph, Explore und eingebauten Tools.
- Die Kontextberichterstattung trennt die für den Anbieter sichtbare Nutzung vom Komprimierungsdruck und der konfigurierten Reserve, während das adaptive Thinking von Anthropic den Anzeigemodus der API überlässt, sofern ein Betreiber ihn nicht ausdrücklich überschreibt.
- Entwürfe neuer Aufgaben behalten ihren eigenen Projekt-Tab, wenn ein Projekt ausgewählt oder registriert wird, und erfolgreiche Fast-Änderungen der Sitzung füllen den nächsten passenden Entwurf vor, ohne eine abweichende Modellwahl zu ersetzen.

## v0.9.104 - 2026-08-09

- Das Tool-Routing lokalisiert unbekannte Repository-Koordinaten jetzt einmal, weist jede Evidenzfacette einem dedizierten Tool zu, bündelt nur unabhängige Aufrufe und hält Textbearbeitungen und Verifizierung hinter der Patch-Ausführungsbarriere.
- Die Verzeichnisinspektion legt Dotfiles und Dateimetadaten ohne Shell-Erkundung offen, während delegationsfreie Workflows das ungenutzte Lead-Briefing weglassen und eine kleinere, an den Fähigkeiten ausgerichtete Tool-Oberfläche verwenden.

## v0.9.103 - 2026-08-08

- Desktop-Navigation, Eingabe, Studio, Einstellungen und Transkriptoberflächen teilen sich jetzt ein straffer responsives Layout, mit stärkerem Folgen beim virtuellen Scrollen, Behandlung lokaler Dateien und erweiterter DOM-Regressionsabdeckung.
- Der Remote-Renderer wird als installierbare Web-App mit stabilem Manifest, Symbol und reinem Netzwerk-Service-Worker ausgeliefert, während das Relay diese Assets mit den erforderlichen Content-Types für Manifest und Service Worker ausliefert.
- Die Solo-Ausführung trägt keine veralteten Agentendefinitionen für Debugger, Scheduler-Task oder Webhook-Handler mehr und entfernt ihr veraltetes Routing-/Cache-Protokoll, sodass eingebaute Dienste von bearbeitbaren benutzerdefinierten Agenten getrennt bleiben.
- Die gehostete Codex-Bildgenerierung wählt für unterstützte Modelle das Bild-Tool ausdrücklich aus, mit fokussierter Abdeckung des Request-Bodys.

## v0.9.102 - 2026-08-08

- Wartungs-Versionssprung; keine funktionalen Änderungen gegenüber v0.9.101.

## v0.9.101 - 2026-08-08

- Escape holt jetzt wartende, noch unverarbeitete Nachrichten vor allem anderen – Warteschlangenreihenfolge zuerst – in das Eingabefeld zurück, sodass ein Esc mitten im Durchlauf die wartende Folgenachricht bearbeitet, statt den Durchlauf zu unterbrechen; ein zweiter Druck bricht weiterhin ab.
- Workflows sind reine Arbeitsstil-Definitionen: Pakete tragen keine Agentenliste mehr. Jeder definierte Agent (eingebaut und benutzerdefiniert) steht jedem delegierenden Workflow zur Verfügung, Solo bleibt über `delegation: none` delegationsfrei, und das Löschen eines benutzerdefinierten Agenten entfernt ihn auf einmal von jeder Oberfläche, einschließlich Spawn-by-name.
- Einstellungen → Allgemein erhielt unabhängige Schalter für Websuche, Explorer und Erinnerungen; Erinnerungen steuern jetzt die Tools memory/recall plus die Injektion von Core Memory, während Hintergrund-Memory-Zyklen als eigener Schalter zu Kontext wanderten.
- Headless-Rollenläufe und Bench-Sitzungen starten mit ausgeschaltetem Explorer, ausgeschalteter Websuche und ausgeschalteten Erinnerungen (klassische Oberfläche) und schalten sie pro Lauf über Flags oder MIXDOG_FEATURE_*-Variablen wieder ein.
- Die gemeinsame Tool-Richtlinie streicht die obligatorische Verifizierungsrunde nach Bearbeitungen, nimmt pro Nachschlagen die günstigste ausreichende Evidenz und definiert Explore als einfache Quellsuche über Quellbäume und Dateien mit einem konkreten Ziel pro Anfrage.

## v0.9.100 - 2026-08-07

- Das Styling des Kontextbefehls hängt nicht mehr davon ab, zuerst die Einstellungen zu öffnen, und kollidiert nicht mehr mit der globalen Kontextklasse von Monaco; das Wiederanhängen des Transkripts macht eine kleine Radbewegung des Lesers nicht mehr rückgängig.
- Desktop-Packager stellen npm-Downloads jetzt mit einem reinen Abhängigkeits-Cache-Schlüssel wieder her, sodass Versionsstempel von Releases nicht jede Plattforminstallation kalt starten.
- Verborgene Entwürfe gelten als fortsetzbare Arbeit statt als veröffentlichte Releases, was verhindert, dass fehlgeschlagene Releases eine zusätzliche Patch-Version verbrauchen.

## v0.9.99 - 2026-08-07

- Die Typografie des Desktop-Transkripts trennt jetzt Inhalt, Betriebsstatus und Metadaten in eine ruhigere Hierarchie, während Fast ein kompaktes zustandsbehaftetes Symbol verwendet.
- Der Explorer-Abruf fächert jetzt jede konkrete Locator-Facette einmal auf, bewahrt zurückgegebene Pfade wörtlich und beendet die begrenzte Wiederherstellung, statt einen schwachen oder rekonstruierten Anker zurückzugeben.
- Synchrone Lesevorgänge des Modellkatalogs starten keine implizite globale Netzwerkanfrage mehr. Das Sitzungs-Warmup bleibt der einzige Eigentümer der Remote-Katalog-I/O, sodass vom Anbieter injizierte Transporte bei einer Kaltinstallation hermetisch bleiben.
- Die isolierte Release-Lane bereitet eine verifizierte native Code-Graph-Runtime jetzt explizit vor, statt von einer Umgebungs-Binärdatei abzuhängen, die ein früherer Job hinterlassen hat.
- Intel-macOS-Release-Assets nutzen begrenzte HTTP/1.1-Uploads Datei für Datei mit Remote-Abschlussprüfungen und Wiederholungen, sodass eine hängende CLI-Übertragung nicht das gesamte Release unbegrenzt aufhält.
- Die Wiederherstellung unveröffentlichter Releases derselben Version faltet ihre angesammelten Notizen jetzt in diese Version, bevor veröffentlicht wird, statt ausgelieferte Arbeit als Unreleased gekennzeichnet zu lassen.

## v0.9.98 - 2026-08-07

- Die Remote-Browser-Kopplung etabliert jetzt einen authentifizierten Ende-zu-Ende-verschlüsselten Kanal, bevor Sitzungszustand, Terminaldaten oder RPC-Nutzlast das Relay passieren können; unverschlüsselte Medien-Lanes bleiben geschlossen.
- Desktop-Anhänge bewahren Dateiidentität und Metadaten über die Sitzungsgrenze hinweg, mit begrenzter Bild-/PDF-Extraktion und gemeinsamer Medien-Normalisierung für Anbietereingaben.
- Desktop-Onboarding und zugehörige Einstellungstexte sind in jeder ausgelieferten Sprache lokalisiert, während IME-Komposition, virtuelles Transkript-Folgen und Fast-Mode-Steuerelemente sich in lang laufenden Bereichen einheitlich verhalten.
- Sitzungswiederherstellung, Zustellung ausstehender Nachrichten, Anbieter-Katalog-Caching, Titelgenerierung, Worktree-Snapshots und begrenzte Runtime-Metriken werden rund um den einheitlichen Sitzungsdienst verschärft.
- Die Release-Validierung ist in parallele Lanes aufgeteilt, die Desktop-Kompilierung überlappt mit den Gates, vorbereitete Runtimes werden gecacht, und Plattformpakete werden in einen verborgenen Entwurf hochgeladen, bevor atomar veröffentlicht wird. Nur für den Renderer bestimmte Abhängigkeiten werden im Desktop-Archiv nicht mehr dupliziert, was den Windows-Installer um etwa ein Drittel verkleinert.

## v0.9.97 - 2026-08-07

- Sitzungsprotokoll 1 trägt jetzt einen expliziten Kompatibilitätsindex, sodass neuere Clients ältere Daemons ablehnen können, während ältere Clients sich über die unterstützte Kompatibilitätsoberfläche anbinden können, ohne parallele Engine-/Backend-Stacks.
- Desktop-, Terminal-, Kanal-, OAuth- und Memory-Abläufe teilen sich jetzt den einheitlichen maschinenweiten Sitzungs-Daemon; veraltete Engine-/Backend-Transporte, Fallbacks und Kompatibilitäts-Shims wurden aus der Entwicklungslinie entfernt.
- Sitzungs-Eigentümerschaft und Tool-Workload-Gates koordinieren parallele Shell-, Patch-, Read-, Code-Graph-, Memory- und Kanalarbeit mit fairer Zulassung, weniger doppelter I/O und stärkerer Abbruch-/Wiederherstellungsabdeckung.
- Mehrbereichsfokus im Desktop, Tab-Ziehen, Review-Zustand, Benachrichtigungen, Anbieterbenennung, Updater-Diagnose und das Packaging von Entwicklungs-Updates wurden verschärft, mit erweiterten Regressionstests für Renderer und Sitzungstransport.
- Terminal-Bench-Reproduktionsbefehle und Kostenvalidierung verweisen jetzt auf den exakten archivierten Lauf und scheitern klar, wenn eine angeforderte Trial-Menge fehlt.

## v0.9.96 - 2026-08-07

- Die Release-Disziplin verlangt jetzt, dass jedes App-Paket vorab hochgezählt wird, wenn sich das Engine-Wire-Protokoll ändert, hält Workspace-Versionen synchron und veröffentlicht diese ausstehende Identität ohne versehentliche zweite Erhöhung.
- Entwicklungs- und installierte Oberflächen teilen sich weiterhin den bestehenden Daten- und Authentifizierungsspeicher; Protokoll-/Versionsdisziplin verhindert Daemon-Versionsabweichungen bei gleicher Version, ohne Zugangsdaten hinter einem neuen Profil zu verbergen.
- Die Release-Validierung gated jetzt das Plattform-Packaging und entfernt einen doppelten Code-Graph-Lauf, wodurch fünf teure Paket-Jobs vermieden werden, wenn ein fokussiertes Gate fehlschlägt.
- Desktop-Protokollkonflikte erklären jetzt den Wiederherstellungsweg über Update bzw. Schließen und erneutes Öffnen, statt eine rohe Sitzungstransport-Ausnahme zu zeigen.
- Der einheitliche Protocol-1-Daemon entfernt den doppelten Desktop-Sitzungshost, stellt das Wiederverbindungs-/Resync-Verhalten des Daemons wieder her und bewahrt abgeschlossene Tool-Arbeit über Zeitüberschreitungs- und Abbruchgrenzen hinweg.

## v0.9.95 - 2026-08-06

- Ein maschinenglobaler Prozess besitzt jede Live-Sitzung, und die Terminal-TUI sowie jedes Desktop-Fenster binden sich als Ansichten über einen 127.0.0.1-HTTP+SSE-Transport an, sodass zwischen den Oberflächen keine Eigentümer-/Betrachter-Rolle ausgehandelt werden muss.
- Gesendete Prompts können zwischen Oberflächen nicht mehr verloren gehen. Das Senden einer Daemon-Ansicht behält seine synchrone Antwort, wird aber wiederholt, bis die Engine es annimmt (und nach einem Daemon-Neustart erneut zugestellt), ein Live-Share-Submit wird vom Eigentümer bestätigt und fällt auf den dauerhaften Spool zurück, wenn er abgelehnt oder unbestätigt bleibt, und die Warteschlange verwirft eine erneut zugestellte Submission-ID, statt die Nachricht zweimal zu senden.
- Editieren über Clients hinweg: Das Fortsetzen einer Sitzung, die eine andere Ansicht bereits hält, übernimmt jene Live-Engine, statt eine zweite Kopie zu laden, Engine-Frames werden an jede Ansicht verteilt, und eine Engine endet erst mit ihrer LETZTEN Ansicht – sodass ein Terminal und ein Desktop-Fenster eine Sitzung Durchlauf für Durchlauf gemeinsam steuern können.

## v0.9.94 - 2026-08-05

- Die Desktop-Tab-Leiste verkleinert Tabs gemeinsam in Richtung der Untergrenzen für aktiv/inaktiv, wobei jeder Tab sichtbar bleibt, statt zu scrollen, und Touch-Shells klappen zu einer Umschalterliste aus Titel + Anzahl zusammen.
- Gestreamtes Markdown heilt das Live-Ende (nicht geschlossene `**`, `` ` ``, `~~`) und begrenzt die Geometriesperre von Fenced Code auf seinen eigenen Chunk, sodass Überschriften, Listen und Fettdruck formatiert werden, während das Modell noch tippt.
- Die Durchlaufprüfung wanderte in die gescrollte Timeline (Durchlauf-Diffs reisen mit dem Thread), was die Verschiebung des Eingabestapels beim Betreten einer Sitzung beendet; Hinweise im Warnton verwenden jetzt das bernsteinfarbene Statuspaar statt des neutralen.
- Das native Beschriftungsband ist transparent, sodass die DOM-Titelleiste und Dialog-Scrims es direkt abdunkeln; das ◀-▶-Paar zum Bereichswechsel ist ausgemustert (Alt+Links/Rechts behält den Fokuszyklus), und Projektdialoge halten den Anspruch auf die Titelleistenabdunklung.
- Die Desktop-UI-Aufnahme steuert „New task“ und Einstellungen über Strg+N / Strg+, an, legt die Aufnahmesprache fest und prüft das schmale 360px-Einstellungslayout.
- Verfeinerungen am TUI-Transkriptfenster und am Jitter-Harness sowie Desktop-Sonden für Wettläufe bei der Sitzungsauswahl.

## v0.9.93 - 2026-08-04

- Abhängigkeitsaudit auf null für Core und Desktop: `npm audit fix` für fast-uri, ip-address, hono/@hono/node-server, Root-undici und brace-expansion; das verschachtelte undici-Override von discord.js wurde auf 6.28.0 angehoben; das Desktop-`dompurify`-Override `^3.4.12` beseitigt den Monaco-XSS-Stapel.
- README-Feature-Audit: Desktop-Workbench-Abschnitt, Details zum Memory-Subsystem, QR-Relay-Kopplung, Cron mit Ruhezeiten und lokale Whisper-Transkription, parallele Bereichssitzungen, Onboarding-Assistent.
- Discord: Der letzte registrierte Slash-Befehl (`/stop`) wurde entfernt; beim Start werden weiterhin veraltete globale/Gilden-Befehlssätze gelöscht.
- Terminal-Bench 2.1: korrigierte Ergebnisse, Ersatz-Vergleichsdiagramme und Reproduktions-/Verifizierungsskripte.
- CI: Deploy ist jetzt der einzige Release-Einstiegspunkt (Token-Lieferkette eingefaltet, Hintertüren per Tag-Push entfernt) mit einem Changelog-Release-Gate.
- Paketversionen auf 0.9.92 vereinheitlicht (Mobile/Relay angeglichen) und die Repository-Historie auf eine saubere Wurzel zusammengeführt.

## v0.9.92 - 2026-08-02

- Basis-Release: npm-Paket, Desktop-Installer und native Supply-Chain-Assets (Runtime, Patch, Graph, Token, Sprach-Runtime).



