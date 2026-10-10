# Registro delle modifiche

Modifiche rilevanti, dalla più recente. La pipeline di Deploy rifiuta di rilasciare finché la sezione Unreleased è vuota, e la contrassegna con la versione rilasciata.

## Unreleased

## v1.0.12 - 2026-10-10

- Il registro delle modifiche in Impostazioni > Informazioni elenca le note della versione installata;
  in v1.0.11 si fermava ancora a v1.0.10, sia nell'app desktop sia nella pagina web remota.

- Il registro delle modifiche è disponibile in ogni lingua dell'app e, dopo un
  aggiornamento, l'app mostra una sola volta le novità di quella versione.

- Il Ragionamento automatico è attivo per impostazione predefinita sui modelli supportati: ogni messaggio e
  ogni passo di uno strumento ottiene il livello di ragionamento di cui ha bisogno. Il suo modello viene scaricato
  in background al primo utilizzo anziché all'avvio, e la scheda Integrato
  mostra il modello e su cosa si basa.

- I link ai file in una conversazione si aprono accanto ad essa, nel pannello laterale, come schede. Un
  nuovo link sostituisce la scheda di anteprima, così i link non accumulano schede; una scheda
  viene mantenuta quando ci fai doppio clic, scegli Mantieni aperto o modifichi il file. Al
  massimo otto schede di file restano aperte. Impostazioni > Generale > Anteprima dei link disattiva
  questo comportamento.

- I file CSV e TSV si aprono come tabella modificabile: copia e incolla celle, aggiungi o
  rimuovi righe e colonne, salva con Ctrl+S e annulla o ripristina con Ctrl+Z
  e Ctrl+Y.

- I file PDF e Office (Word, PowerPoint, Excel) hanno l'anteprima nel pannello laterale.
  Le pagine Office si riaprono all'istante, e un link avvia la conversione del suo documento
  non appena ci passi sopra con il puntatore.

- Le conversazioni possono essere contrassegnate con la stella: i preferiti restano in cima all'elenco
  delle sessioni, e la stella compare quando passi il puntatore su una riga.

- La ricerca trova il testo nelle conversazioni passate. Una conversazione eliminata
  non lascia risultati di ricerca, in qualunque modo sia stata rimossa.

- Scorrere verso l'alto mentre una risposta è in streaming mantiene la posizione invece di tornare
  di scatto in fondo.

- Le azioni GitHub in una risposta sono raggruppate in un'unica scheda GitHub, e il ciclo
  dell'indicatore di ragionamento non salta più quando riparte.

- Gli account dei provider mostrano l'email di accesso, e collegare di nuovo lo stesso
  account mantiene il suo nome e la cronologia di utilizzo invece di aggiungere una nuova
  voce. La finestra di utilizzo non elenca più gli account che sono stati scollegati.

- Un prompt ripreso dalla coda nella bozza non ricompare più
  dopo un riavvio, e riaprire rapidamente l'app mantiene la conversazione
  modificabile invece di aprirla in sola lettura.

- Correzioni alle traduzioni: etichette errate come Git in italiano, Models in
  vietnamita ed Effort in cinese e giapponese ora vengono mostrate correttamente.

- Nell'interfaccia web per telefono, Invio inserisce un'interruzione di riga e il pulsante di invio
  invia.

- La Memoria si avvia sui profili Windows il cui nome della cartella utente non è composto da semplice
  ASCII.

- Aggiornamenti di sicurezza per le dipendenze image-size e js-yaml
  (CVE-2025-71329, CVE-2026-84375).

## v1.0.11 - 2026-10-08

- Il browser integrato mostra di nuovo le pagine sui display Windows con scala superiore al
  100%, invece di fallire con "Browser display did not recover after the
  page changed" (#8). Le pagine seguono anche le variazioni di scala del display, comprese le
  schede che in quel momento non erano visibili.

- I file Word, PowerPoint ed Excel (.docx, .pptx, .xlsx, .xlsm) possono essere
  allegati ai messaggi e alle automazioni, e il loro testo arriva a tutti i modelli.
  I tipi di file che non possono essere allegati ora lo indicano e inseriscono invece il percorso
  del file, mentre i file vuoti o che non sono veri PDF vengono rifiutati con
  un messaggio chiaro.

- I PDF e le immagini di una parte precedente della conversazione vengono ancora inviati al modello
  dopo il riavvio dell'app. I modelli senza supporto PDF nativo ricevono il
  testo del PDF. La lettura di un PDF di oltre 100 pagine restituisce come testo le prime pagine,
  mentre i PDF protetti da password o non validi restituiscono un errore chiaro invece di
  compromettere le richieste successive.

- Le immagini e i file restituiti dagli strumenti MCP arrivano al modello come immagini e file
  invece che come testo codificato grezzo; i contenuti multimediali non supportati o troppo grandi vengono descritti.

- I riepiloghi creati quando una conversazione lunga viene compattata ora includono i messaggi
  lunghi e segnalano le immagini e i file allegati.

- I modelli locali solo testo mantengono il testo dei documenti allegati, e le immagini
  precedenti diventano una breve nota invece di interrompere la conversazione.

- Il feedback, con screenshot opzionali, può essere inviato da Impostazioni > Informazioni,
  e lì si può leggere anche il registro delle modifiche.

- I messaggi recenti della conversazione possono essere trovati per significato nel recupero dalla memoria
  subito dopo essere stati salvati.

- I risultati di ricerca vengono riutilizzati solo finché sono ancora aggiornati (#7), e una
  ricerca di elenco file dopo una ricerca di contenuto restituisce i nomi dei file invece del
  contenuto precedente (#9).

## v1.0.10 - 2026-10-08

- I provider API personalizzati possono essere registrati in Impostazioni con adattatori di
  connessione specifici per provider.

- I codici QR per la connessione remota compaiono solo quando il relay è pronto, e le
  schede di associazione obsolete vengono rimosse.

- Gli alias dei modelli OpenRouter in rotazione possono essere selezionati e salvati per Principale
  e per gli agenti. Gli alias più recenti e i modelli stabili non vengono più nascosti per errore
  a causa dell'età del catalogo, delle anteprime più recenti o dei limiti di famiglia del selettore dei modelli.

- L'inizializzazione della patch nativa mantiene attivo il proprio processo finché la verifica è
  in sospeso, evitando un'uscita anticipata quando il precaricamento e la verifica si sovrappongono.

## v1.0.9 - 2026-10-07

- Le istruzioni comuni e di progetto arrivano a ogni nuova conversazione anche quando
  l'estensione Memoria non è installata o è disattivata; quell'interruttore ora
  riguarda solo gli strumenti di memoria e recupero. Il salvataggio di un'istruzione non
  attende più diversi secondi il modello di embedding, le istruzioni vengono inserite così
  come scritte senza ID interni, e possono arrivare a un totale di 32 KB.

- L'accesso a GitHub da Impostazioni, e ogni altra funzione che avvia un
  processo del terminale, funziona di nuovo nell'app desktop installata invece di
  fallire con "posix_spawnp failed". Un account GitHub aggiuntivo obsoleto memorizzato da
  gh non fa più sì che un accesso riuscito segnali "no account is signed in".

- Browser Use e Computer Use non chiedono più approvazione prima della loro prima
  chiamata in una sessione, e `setup set_first_use_approval` non esiste più.

- La scheda di approvazione degli strumenti corrisponde alle schede impilate sopra l'input: l'icona
  di avviso, il titolo e lo strumento stanno su una sola riga, il motivo sta sotto con
  solo il comando, il percorso o l'URL da approvare (niente riga della cartella né elenco
  degli argomenti), e Nega sta discreto accanto a Consenti.

- I nuovi modelli ricavano le loro capacità dai cataloghi dei provider invece di
  attendere un rilascio: modifiche dello sforzo a metà conversazione sul
  percorso ChatGPT, Fast mode e impostazioni della cache sul percorso API OpenAI, Fast mode su
  Claude e sforzo di ragionamento su xAI. GPT-6.1 Sol e Claude Sonnet 5.5 sono
  ora coperti, e l'interruttore Fast non compare più sui modelli Claude che
  non possono usarlo.

- Claude Sonnet 5.5 mostra di nuovo le sue note tra una chiamata di strumento e l'altra, e i modelli Claude
  Fable e Mythos possono usare la ricerca web ospitata.

- La versione del client che ogni provider si aspetta viene ricordata tra un'esecuzione e l'altra, così
  un riavvio o un avvio offline non ricade più su un vecchio valore integrato.

- Altri errori "conversation too long" da GLM, Kimi, Qwen, MiniMax, xAI e
  altri backend ora attivano la compattazione invece di terminare il turno, e un
  sovraccarico di Claude a metà risposta segue le stesse regole di nuovo tentativo e fallback di uno
  all'inizio di una risposta.

- Avvisi ed errori non si impilano più sopra l'input: le conferme dei comandi slash
  e gli errori di microfono, allegati e comandi appaiono come
  notifiche, e l'avanzamento del download della voce compare solo nella sua scheda in Impostazioni.
  Ogni errore ora si legge allo stesso modo, senza scheda riquadrata, e i download dei
  modelli locali mostrano una barra di avanzamento a tutta larghezza sotto la loro riga.

## v1.0.8 - 2026-10-05

- L'app macOS è firmata con un certificato Developer ID e notarizzata da
  Apple, così una copia scaricata si apre senza avviso di Gatekeeper e
  l'aggiornamento automatico di macOS può installare nuove versioni. Le richieste di microfono e AppleScript
  ora spiegano per cosa le usa Mixdog.

## v1.0.7 - 2026-10-04

- Browser Use sul telefono trasmette in diretta la pagina del desktop invece di
  aggiornare istantanee, e accetta lo stesso input di mouse, tocco, rotella, tastiera e
  IME del riquadro desktop. Quando un agente cede la pagina (per
  esempio un CAPTCHA), si apre anche sul telefono.

- L'attività degli strumenti nella trascrizione è più facile da scorrere: ogni riga inizia con un
  breve verbo, letture e ricerche mostrano i risultati per file, gli elenchi mostrano righe di
  file, i comandi stanno in un riquadro a parte, l'output di `git diff` viene reso come diff,
  e una pagina visitata dal browser ottiene una scheda che la riapre nel riquadro.

- Le notifiche di turno concluso arrivano prima, mostrano testo semplice invece di Markdown
  grezzo, terminano con una frase completa e non vengono più trattenute da
  lavori shell in background di lunga durata.

- Le sessioni usate di recente si aprono più velocemente dopo un riavvio e quando vengono rivisitate.

- Lo strumento setup può gestire account OAuth, opzioni sviluppatore, elementi fissati della barra
  attività e il server MCP di un plugin, e le richieste dalle sessioni a riquadri divisi vengono
  gestite. La finestra di cancellazione automatica propria di un provider ora ha la precedenza su quella globale.

- Lo strumento Git si attiva ovunque sia installato `git`, senza installare
  un'estensione. Pianificazioni e webhook consegnano sempre alla sessione dell'app.

- L'interfaccia dell'app resta alla scala del 100%, le impostazioni salvate in un'altra finestra o
  nel terminale si applicano subito, e bordi, icone, spaziatura degli elenchi e
  ingressi delle finestre di dialogo sono più coerenti.

## v1.0.6 - 2026-10-03

- Le notifiche push sul telefono restano silenziose mentre l'app è in primo piano, seguono una
  sottoscrizione che il browser rinnova da solo, e l'interruttore si disattiva quando
  le notifiche sono bloccate nelle impostazioni di sistema.

- L'app per telefono non resta più sulla schermata di caricamento quando torna dopo
  un aggiornamento del relay; termina il caricamento non appena il desktop si riconnette, e
  un primo avvio veloce non salta più l'installazione del service worker dell'app.

- Su Android, il gesto indietro chiude il pannello o il menu aperto senza
  far lampeggiare la barra di navigazione.

- Le schede dello spazio di lavoro, l'intestazione del pannello laterale e il pulsante di pulizia di Studio sono
  più compatti, e la scheda selezionata risalta in modo più chiaro.

- Le etichette di Utilizzo sono più brevi, la quota da azzerare viene espressa per ora quando
  resta meno di un giorno e non supera mai quanto rimane, e le traduzioni sono
  state rifinite in tutte le lingue.

## v1.0.5 - 2026-10-03

- L'app desktop può mostrare una notifica del sistema operativo, con un suono, quando un turno
  termina con la risposta finale, e la notifica riporta a quella
  sessione.

- Gli strumenti Office creano documenti docx, xlsx e pdf da HTML tramite un'unica
  sessione del browser condivisa.

- Utilizzo mostra stime del valore della quota e totali per sessione.

- Gli host di Browser e Computer Use sono più robusti: trasformazioni dei frame, privacy
  visiva, screenshot a riquadri e ripristino dopo gli errori.

- Il controllo della sintassi PowerShell non scambia più per cmdlet i frammenti verbo-trattino all'interno
  dei percorsi.

- `adm-zip` è aggiornato a 0.6.1 per CVE-2026-102282.

## v1.0.4 - 2026-10-01

- I selettori dei modelli si aggiornano non appena cambia un provider. Gli accessi OAuth
  tramite browser (OpenAI, Grok, Cursor, Antigravity) e i cambi di account ora
  ricaricano subito il selettore invece che dopo un riavvio, e un provider
  connesso, rimosso o cambiato in una finestra aggiorna anche ogni altra
  finestra desktop e il telefono associato.

- La chiusura della finestra non chiede più cosa fare. Le impostazioni offrono una scelta "Alla
  chiusura della finestra" tra nascondere nell'area di notifica (predefinito) e
  uscire completamente, l'icona nell'area di notifica è disponibile fin dall'avvio, e la
  richiesta di conferma di uscita nell'app non c'è più.

- Le righe degli agenti del workflow si leggono allo stesso modo ovunque: una riga senza modello
  fissato, inclusa Ricerca web, mostra "Predefinito", e i nomi degli agenti e le etichette
  dei modelli restano non tradotti. Le schede dello spazio di lavoro non selezionate poggiano su una tenue base
  invece che su sottili divisori.

- Lo strumento Obiettivo e la skill goal-management descrivono gli Obiettivi come un elenco di attività
  per il lavoro approvato portato avanti tra più turni, ed escludono le pianificazioni ricorrenti e
  gli obiettivi che attendono per settimane eventi esterni.

## v1.0.3 - 2026-10-01

- La generazione di contenuti multimediali registra una riga di utilizzo per ogni lavoro su immagine o video con i
  token, le immagini, i secondi e il costo riportati dal provider, così i contenuti multimediali di Gemini,
  Antigravity, Codex e xAI compaiono nei totali di utilizzo e costo insieme
  ai modelli di testo. Le tariffe dei contenuti multimediali provengono dal catalogo prezzi pubblicato.

- Stop e Riprendi di Computer Use si ripristinano correttamente dopo una pulizia non riuscita: i worker
  inattivi vengono ritirati invece di andare in timeout, e uno Stop o Riprendi dell'utente
  cancella lo stato obsoleto "input not confirmed released".

- Le sessioni in attesa di lavori shell in background risultano in attesa anziché inattive,
  e l'indicatore dei lavori shell non mostra più i lavori di un precedente proprietario né perde
  gli aggiornamenti che arrivano durante un polling. Gli elenchi di sessioni e agenti evitano ridisegni
  superflui quando nulla è cambiato. Il grafico di utilizzo, le pagine della barra, le schede dello spazio di lavoro,
  gli elenchi delle estensioni e le finestre di dialogo hanno uno stile rinnovato.

- Scansioni grep e read concorrenti identiche condividono un'unica scansione nativa, i risultati
  in cache vengono invalidati per percorso dopo le modifiche, e una patch annullata si ferma
  prima di scrivere altri file. La ricerca di code graph abbina i percorsi Windows
  indipendentemente da maiuscole, separatori, prefissi verbatim (`\\?\`) e UNC. Un
  hook pre-strumento che fallisce ora blocca lo strumento invece di lasciarlo eseguire.

- La skill del browser mantiene le pagine in background a meno che la pagina stessa
  sia il risultato da consegnare o l'utente debba agire su di essa. Lo sviluppo desktop
  (`npm run dev`) e gli script E2E diretti per Windows vengono eseguiti in un profilo isolato nuovo
  sulla porta CDP `9342`.

## v1.0.2 - 2026-10-01

- I pulsanti di copia della trascrizione possono scrivere negli appunti dalla finestra desktop
  attendibile. Il testo delle risposte, i blocchi di codice, l'output degli strumenti e i diff per file
  hanno una copertura di regressione per il testo copiato esatto, i nuovi tentativi e i contenuti variabili;
  le letture degli appunti e le autorizzazioni per le altre finestre restano bloccate.

- I comandi del modello e dello sforzo aprono il selettore del modello della conversazione corrente, e
  gli agenti disattivati mantengono il modello selezionato per loro. Il tutorial iniziale
  spiega la raccomandazione del modello Maintainer, e la diagnostica ora copre
  provider locali, funzioni integrate, voce e plugin mancanti o non validi.

- I link ai file di Windows gestiscono separatori codificati e percorsi con spazi o
  testo coreano. Una menzione di file che ha fallito la ricerca iniziale può essere cliccata
  per riprovare. Seleziona tutto di Studio include ogni elemento della scheda, non solo
  le pagine già caricate.

- Computer Use mantiene allineati i riferimenti di acquisizione con le riletture dell'accessibilità,
  riassocia in sicurezza i controlli ricostruiti solo quando la loro identità osservata corrisponde,
  e attende mentre il desktop di input è bloccato invece di trattare il blocco come
  un errore dell'osservatore.

- Le schede dello spazio di lavoro e il tutorial iniziale hanno uno stile più chiaro, la barra laterale
  delle sessioni parte aperta, e i gruppi di strumenti non mostrano più il badge aggregato di errore.
  Il testo delle istruzioni di progetto non viene più aggiunto al blocco dell'ambiente del prompt di sistema.
  I pacchetti pubblicati escludono i test di sviluppo annidati.

## v1.0.1 - 2026-09-30

- L'app desktop su Windows 11 ora si trova in una cornice di finestra Mica con una shell più
  calma e monocromatica: popup e pannelli si distinguono con l'ombra invece dei bordi,
  le selezioni non diventano più blu, e l'accento è riservato allo stato attivo. Il testo
  segue un'unica scala tipografica (da didascalie di 12px a titoli di pagina e cifre
  in evidenza di 20px), la scheda selezionata è una card in rilievo, i pulsanti distruttivi restano
  neutri finché non ci si passa sopra, e i grafici di utilizzo e contesto condividono un'unica palette.

- La chiusura della finestra chiede una sola volta se lasciare Mixdog in esecuzione nell'area di notifica o
  uscire completamente, e ricorda la risposta. L'uscita mentre un agente sta ancora
  lavorando chiede ogni volta.

- L'utilizzo dell'abbonamento mostra la quota di ciascun modello come area impilata sotto la
  linea del totale, e la sua card al passaggio segue il puntatore solo all'interno del grafico.

- La conversazione resta agganciata al suo ultimo messaggio quando una card cambia
  altezza durante lo scorrimento. I file SVG scritti da un agente compaiono come risultati immagine
  e si aprono nel visualizzatore di sistema, e gli agenti consegnano il lavoro visivo, come
  SVG o pagine HTML, come file salvati invece di incollarne il sorgente.

## v1.0.0 - 2026-09-30

- La Memoria non può più essere messa fuori uso da una ricostruzione del runtime. Un runtime di memoria
  ricostruito viene pubblicato con un nuovo tag di rilascio invece di sostituire i file
  che le app installate verificano, un nuovo runtime si installa accanto a quello in uso
  invece di eliminarlo mentre PostgreSQL è ancora in esecuzione da esso, e due
  processi che installano contemporaneamente non si cancellano più a vicenda il download. I
  deploy di sviluppo locale rifiutano di partire da un branch indietro rispetto al suo upstream.

- Le card degli strumenti non segnano più come fallite le chiamate concluse. Un comando il cui output
  contiene una riga `status:`, un `git diff --quiet` o `git grep` che segnala una
  differenza o nessuna corrispondenza, una ricerca code_graph che non trova alcun simbolo e la paginazione
  dei risultati tidy memorizzati ora risultano completati; un comando git che esce con codice diverso da zero
  risulta come uscita, come la shell; e un comando del browser o del computer interrotto
  perché l'utente ha preso il controllo risulta annullato.

- Meno chiamate di strumenti falliscono per un errore di argomento al primo tentativo: lo strumento git aggiunge un
  `git` iniziale mancante, read dichiara nel suo schema il limite di 10 destinazioni, e
  un Obiettivo pieno di attività completate spiega come fare spazio per le nuove. I log
  degli errori ora registrano le destinazioni di read e la dimensione completa dei batch di percorsi.

- Le richieste vengono tariffate al livello con cui sono state effettivamente inviate: le richieste Fast e
  Priority usano le tariffe pubblicate, una richiesta Fast ritentata come
  standard viene fatturata come standard, e le varianti Cursor Fast vengono fatturate come il
  modello del catalogo. Attivare Fast aggiorna subito la barra di stato.

- Le regole di convalida dei dati di Excel vengono controllate prima della creazione di una cartella di lavoro, così un
  tipo di regola sconosciuto o un limite mancante fallisce subito su entrambi i backend. Il
  riflesso dell'attività in tempo reale è una banda più corta e più pallida, e i nomi di riepilogo degli strumenti usano
  il peso medio.

## v0.9.175 - 2026-09-29

- Gli agenti Claude ora mantengono la cache della conversazione per 5 minuti invece di
  un'ora. Quando la richiesta successiva di un agente arriva dopo la scadenza di quella cache —
  dopo una lunga build o un test, o quando un agente concluso viene ripreso — esso
  compatta prima la propria conversazione, così la richiesta riscrive la conversazione compattata
  invece di tutto ciò che l'agente aveva accumulato. In una riproduzione dell'uso
  recente degli agenti Claude questo ha ridotto il costo in token degli agenti di circa un quarto. Le
  sessioni Lead restano invariate.

- Molte sessioni in esecuzione in parallelo non si rallentano più a vicenda. I messaggi
  in sospeso sono mantenuti per sessione, i riepiloghi delle sessioni e l'utilizzo del gateway vengono
  aggiunti invece che riscritti, le trascrizioni memorizzate vengono analizzate fuori dal ciclo
  principale, e un ciclo di memoria che fallisce rallenta i tentativi invece di ripetere in un ciclo serrato.
  Quando il daemon termina, registra il motivo. L'host di sessioni multiprocesso separato non
  esiste più; le sessioni vengono eseguite nel daemon stesso.

- L'utilizzo dell'abbonamento registrato prima di un cambio di account ora viene attribuito
  all'account in uso quando è iniziata la registrazione. Grok, Claude e Cursor
  riportano le versioni correnti del loro client invece di quelle fisse.

- L'app desktop non mostra più una sessione vuota quando il daemon consegna
  il contenuto subito dopo aver risposto alla richiesta di apertura. Lo script di avvio
  dell'app pacchettizzata è consentito dalla content security policy, e i controlli della radice del progetto,
  gli errori di dispatch del relay e il ripristino della sessione del browser sono stati corretti.

- Cartelle di lavoro e documenti modificati senza Office: svuotare una cella vuota non
  elimina più la cella successiva, l'eliminazione di un commento trova i commenti con
  formattazione dell'autore, le parti collegate con percorsi assoluti vengono risolte, e il testo che
  sembra un pattern di sostituzione viene inserito letteralmente.

- I runtime scaricati (PostgreSQL, pgvector, font, FFmpeg) vengono controllati
  rispetto a checksum fissati prima dell'uso. Gli strumenti nativi correggono un'analisi di
  window-id che poteva spezzare un carattere multibyte, un calcolo del tempo che poteva
  andare in overflow e una sostituzione di snapshot che poteva lasciare un file parziale.

## v0.9.174 - 2026-09-29

- La finestra di utilizzo ora risponde a una seconda domanda: come è stata
  consumata la quota di un abbonamento. Accanto all'utilizzo dei token, una scheda Utilizzo abbonamento segue le
  finestre di limite di ciascun provider — Codex, Claude, Grok, Cursor, Antigravity e
  OpenCode Go — mentre salgono e si azzerano, con i modelli che hanno mosso il contatore
  e la cronologia delle finestre precedenti. Mixdog registra ogni lettura della quota che
  misura; un aumento senza alcuna richiesta Mixdog alle spalle compare come uso esterno a
  Mixdog, ad esempio dall'app web del provider. Un contatore del provider nel riquadro
  a comparsa dell'utilizzo apre direttamente il suo abbonamento.

- `/doctor` funziona anche nell'app desktop, come finestra di dialogo (anche in Impostazioni →
  Sistema → Doctor). Esegue gli stessi controlli di integrità di sola lettura della TUI, tutti
  insieme con una scadenza per ciascun controllo, così un controllo bloccato non può nascondere gli
  altri, e ogni avviso o errore indica come risolvere.

- I nuovi set di diapositive PowerPoint vengono progettati in HTML. Il modello imposta ogni diapositiva in
  HTML e CSS, un Chrome o Edge locale la renderizza, e `author` trasforma ciò che il
  browser ha disegnato in oggetti PowerPoint nativi e modificabili: caselle di testo che mantengono
  le interruzioni di riga del browser, forme, linee, tabelle, grafici e immagini.
  Il testo coreano va a capo dove un lettore se lo aspetta, un controllo della geometria rifiuta le diapositive
  le cui allineamenti dichiarati il browser non può confermare, e `render` mostra
  ogni pagina HTML accanto al suo render PowerPoint. La via dello script resta per i
  set che vogliono i dispositivi misurati del kit, o quando non esiste un browser locale.

- Inserire o eliminare righe e colonne in una cartella di lavoro senza Excel ora
  riscrive tutto ciò che nomina quelle celle, come fa Excel: formule su
  ogni foglio, nomi definiti e aree di stampa, formati condizionali,
  convalide, serie dei grafici, origini delle pivot, filtri, collegamenti, unioni, tabelle e
  disegni. Prima le celle si spostavano mentre i loro riferimenti restavano fermi, quindi il
  totale di un report continuava a sommare il vecchio intervallo e riportava 72,200 dove Excel riportava
  74,700. Una modifica i cui riferimenti non possono essere riscritti viene rifiutata, con
  l'elenco, prima che cambi qualcosa.

- I PDF e le fasce di fogli di calcolo composte mantengono su una sola riga date, orari, frazioni e
  importi coreani. "10월 14일", "14시 30분", "3분의 1", "12만 6천 원" e
  "24억 원" non vengono più spezzati a metà, cosa che aveva diviso una data di decisione o
  un risparmio su due righe.

- I file Office risultano identici sia che li abbia prodotti Microsoft Office sia il
  writer portabile integrato. Un lungo confronto affiancato dei due ha
  allineato spaziatura, modalità di compatibilità e tabelle di Word; adattamento automatico, rientri,
  bordi, impostazioni di stampa e grafici predefiniti di Excel; a capo coreano, font dell'Asia
  orientale, piè di pagina, ritagli di copertina, ombre e trasparenza di PowerPoint; e allineamento
  e larghezze delle tabelle dei PDF. I controlli di revisione segnalano gli stessi problemi su entrambi i
  backend, i grafici di Excel possono leggere l'intervallo di un altro foglio, e `set_chart_data`
  mantiene i collegamenti e i nomi delle serie di un grafico.

- Computer Use funziona su macOS e Linux. Le build desktop per quei sistemi
  includono un backend nativo che parla il protocollo dell'host Windows e applica
  le stesse liste di azioni e gli stessi limiti. Una sequenza può ora anche agire su più
  elementi di una stessa osservazione: ogni passo successivo riverifica il proprio elemento rispetto
  all'albero di accessibilità attivo, e la catena si ferma a un cambio di finestra, a un
  errore, o a un elemento disabilitato o fuori schermo.

- L'app per telefono si apre e si riconnette più velocemente e sposta molti meno dati. La
  trascrizione compare subito dopo la prima sincronizzazione, le brevi riconnessioni riprendono
  come delta invece che con una risincronizzazione completa, il telefono rispecchia solo la scheda che mostra,
  la revisione compressa del turno legge nomi e conteggi dei file senza il testo della patch,
  e le ricerche lente nei progetti non bloccano più altre chiamate. Un'app per telefono tenuta
  aperta controlla se c'è un nuovo deploy quando torna in primo piano,
  e ne adotta uno fuori schermo anche a metà turno.

- Il daemon usa meno memoria e si blocca meno: le sessioni salvano solo ciò che
  è cambiato, il registro di utilizzo lavora fuori dal thread principale, i blocchi dei file e le chiamate
  git non lo bloccano più, e le trascrizioni lunghe vengono caricate a pagine da 1 MB. Desktop
  e telefono renderizzano il Markdown in streaming e lo scorrimento touch con meno layout,
  e la trascrizione dell'app web non sfarfalla più mentre le righe vengono misurate.

- L'input vocale mostra che si sta preparando finché l'acquisizione non inizia davvero, riscalda
  la trascrizione mentre parli e trascrive più velocemente senza bloccare
  l'app.

- I risultati degli strumenti costano meno token al modello. `read` restituisce le sue righe senza
  numeri di riga — la TUI e il desktop disegnano comunque la barra laterale — con circa il 16%
  di token in meno nelle sessioni registrate; gli avvisi di shell e task sono più brevi; e
  le modifiche riportano i percorsi relativi alla directory di lavoro.

- La compattazione porta con sé meno materiale obsoleto nelle finestre di contesto ampie. La
  conversazione letterale e la cronologia recente degli strumenti mantenute attraverso un Compatta sono
  limitate a 20,000 token invece di crescere con la finestra. Uno snapshot del browser
  o un'osservazione del desktop sostituiti da una successiva della stessa pagina o finestra
  mantiene solo il suo esito e un riferimento all'originale archiviato, e
  le risposte più vecchie scartano il replay opaco del provider mantenendo le loro chiamate
  e i loro risultati degli strumenti.

- Un provider brevemente non disponibile non termina più il turno nel momento in cui
  i suoi tentativi finiscono. Finché nulla è arrivato sullo schermo, il turno
  attende ancora alcuni cicli di recupero, da 15 secondi fino a un minuto,
  e segue il Retry-After del server. Quando uno stream si interrompe mentre gli argomenti di una chiamata
  di strumento stanno ancora arrivando, quella chiamata non viene eseguita, e al modello viene
  detto di dividere il contenuto in chiamate più piccole invece di rinviarlo
  per intero.

- OAuth di Cursor e Antigravity (Gemini) sono interruttori separati in Impostazioni →
  Sviluppatore, e ciascuno si attiva solo dopo che si conferma il rischio di
  restrizioni dell'account legato all'uso di quel provider tramite OAuth. La
  variabile d'ambiente `MIXDOG_DEV_PROVIDERS` non li attiva più.

- La conversazione non salta più quando le barre sopra il composer si aprono o
  si chiudono: scorrono sopra il movimento invece di spostare la trascrizione di
  tutta la loro altezza in una volta, e l'apertura di una sessione non fa più lampeggiare un conteggio di
  revisione del turno che scompare un attimo dopo.

- Rinominare un file o una cartella nell'explorer mantiene le sue schede dell'editor aperte
  sul nuovo percorso. Un file con modifiche non salvate viene rifiutato finché non viene salvato, poiché il suo
  buffer appartiene al vecchio percorso.

- Studio ripulisce in blocco: gli elementi selezionati, tutto ciò che precede una data,
  le voci i cui file non esistono più, o tutto di un tipo. Impostazioni → Informazioni elenca un
  indirizzo di supporto con i pulsanti Copia ed Email, e la finestra di dialogo del browser integrato
  Clear browsing data è stata rimossa.

- Un turno automatico di obiettivo che non chiama alcuno strumento ora attende invece di
  sollecitare di nuovo.

## v0.9.173 - 2026-09-22

- Un messaggio in coda ripristinato mantiene il testo confermato dal daemon. Ripristinarne uno
  pubblica due volte nello stesso istante — prima la stima locale, la risposta del daemon
  un attimo dopo — ed entrambe erano marcate con l'orologio. Quando
  arrivavano nello stesso millisecondo il prompt considerava la seconda come la prima e
  teneva la stima, così un messaggio modificato poteva tornare sottilmente errato. Il prompt
  ora segue il testo stesso, non solo il timbro.

- Saltare due volte nello stesso istante non perde più il secondo salto. Due richieste "vai a questa
  riga" nello stesso millisecondo avevano lo stesso timbro, e l'editor leggeva solo il timbro, quindi la seconda veniva scartata e il cursore restava
  sulla prima riga.

- Una ricerca che va in crash non porta più con sé l'intero motore di ricerca. Il
  motore sapeva già rispondere a una richiesta errata con un errore e continuare a
  servire, ma la build distribuita era compilata in modo che qualsiasi crash uccidesse il
  processo — perdendo ogni altra ricerca in corso e l'indice dei file
  caldo. Ora sopravvive, risponde a quella richiesta con un errore e mantiene
  le sue cache. Se un crash avviene mentre i file vengono raccolti,
  i percorsi raccolti vengono comunque pubblicati invece di scomparire silenziosamente dalla
  risposta.

- Applica ed Elimina nella riga di un provider locale stanno sulla stessa linea. Differivano
  di due pixel perché la riga mescolava un input più alto con un pulsante più basso.

- La pulizia del codice ti avvisa quando uno strumento non è quello che pensi. Se un
  formatter o linter con lo stesso nome è raggiungibile sulla tua macchina ma
  non è quello che esegue Mixdog, il report ora nomina entrambi, con le versioni —
  eseguire l'altro binario non dice nulla sul risultato che ti è stato mostrato. Una pulizia
  separa inoltre i riscontri nei file che hai già toccato dai riscontri nei
  file non toccati nel repository, così applicare le correzioni a un'intera
  directory non riscrive più file che non intendevi cambiare.

- L'aggiornamento dell'app installata non si interrompe più perché l'antivirus ha rimosso un
  file che l'aggiornamento scarta comunque. La preparazione decomprimeva l'intera app installata e
  eliminava la parte che stava per sostituire; un solo asset del renderer messo in quarantena
  bastava ad annullare il deploy.

## v0.9.172 - 2026-09-21

- Una pagina non si apre più annunciando download che non ha mai fatto. I file salvati
  appartengono alla sessione, ma ogni pagina teneva traccia di ciò che aveva segnalato partendo
  da zero, così ogni pagina aperta in seguito accoglieva il chiamante con tutto l'arretrato
  — una pagina di ricerca che segnalava un file salvato da un'altra scheda
  minuti prima. Una nuova pagina parte già a conoscenza di ciò che è accaduto prima della sua esistenza;
  un file salvato mentre è aperta continua a raggiungerla.

- I guasti del browser stesso non vengono più scambiati per quelli della pagina. Una chiamata CDP andata in timeout,
  un frame figlio che non è stato possibile agganciare, un'intercettazione a cui non si è potuto rispondere
  — tutti venivano registrati come errori della console della pagina, così una risposta su un
  sito sano poteva aprirsi con `CDP Runtime.evaluate timed out` come se il sito
  lo avesse registrato. Restano leggibili tramite `console`, contrassegnati con `[browser]`, e
  non contano più tra gli errori di cui una pagina è responsabile.

- Una scadenza raggiunta dietro una finestra di dialogo aperta lo dice. Un alert, confirm o prompt
  blocca il thread principale della pagina, quindi la chiamata successiva moriva per timeout con
  nient'altro che la scadenza — e il tentativo ovvio andava in timeout allo stesso modo. L'
  errore ora nomina la finestra di dialogo e il suo testo, e dice di rispondere con
  `handle_dialog` prima di agire di nuovo sulla pagina.

- Un cambio di route lato client riceve come risposta la schermata che ha prodotto, non quella
  che il chiamante ha lasciato. Le app a pagina singola cambiano l'indirizzo con `history.pushState`
  e renderizzano la nuova vista un attimo dopo; nessun documento viene caricato, quindi l'attesa vedeva una
  pagina quieta e restituiva subito — e un `expect.url` era soddisfatto dal nuovo
  indirizzo prima che fosse disegnato qualcosa. Cliccare "Learn" su react.dev rispondeva con
  la home page sotto l'indirizzo `/learn`. Quando un'azione cambia l'indirizzo
  senza un caricamento, la risposta ora attende che la pagina si quieti e una condizione
  URL non può accorciare l'attesa. Misurato sul banco di prova su dispositivi reali:
  le latenze di navigate, click e snapshot sono invariate, perché solo i cambi di route
  nello stesso documento richiedono l'attesa aggiuntiva.

- Il dettaglio di un WebSocket mostra la richiesta di upgrade che ha effettivamente inviato. Venivano registrati solo l'
  indirizzo e la risposta dell'handshake, quindi `network` rispondeva con una sezione di
  intestazioni della richiesta vuota — e un upgrade rifiutato di solito si spiega
  con `Origin`, `Sec-WebSocket-Protocol` o un cookie. Le credenziali restano oscurate.

- Un clic che apre una scheda non viene più segnalato come un clic che non ha fatto nulla.
  Un link `target="_blank"` lascia intatto il documento corrente, quindi la risposta
  diceva "No observable change" e invitava il chiamante a cercare un elemento di copertura —
  mentre la pagina appena aperta stava in `list_tabs` senza essere menzionata.
  La risposta ora nomina la pagina aperta e come agire su di essa.

- `drag` accetta destinazioni senza snapshot come ogni altra azione del puntatore. Le sue due
  estremità accettavano solo ref o coordinate grezze, e gli elementi che una pagina rende
  trascinabili — card, righe di elenco, zone di rilascio — spesso non hanno un nome accessibile
  e quindi nessun ref, per cui spostarne uno significava prima ancorare uno snapshot visivo anche
  quando il selettore CSS era noto. `target` e `dropTarget` ora indicano le due
  estremità, risolte insieme in un'unica osservazione; ref e coordinate funzionano
  come prima, ed entrambe le estremità devono comunque essere indirizzate allo stesso modo.

- Un file salvato non viene più annunciato come richiesta fallita. Un indirizzo che
  si trasforma in un download annulla la propria navigazione, e Chromium segnala quell'
  annullamento come `net::ERR_ABORTED`, quindi una risposta che elencava il download
  lo elencava anche come recente errore di rete. Le richieste annullate — download, fetch
  abbandonati dalla pagina, navigazioni sostituite da un'altra — restano leggibili tramite
  `network` ma non vengono più segnalate spontaneamente come guasti della pagina; una richiesta che
  è davvero fallita lo è ancora.

- Una risposta `brief` non trasforma più un campo compilato in una modifica estesa a tutta la pagina.
  Confronta con l'osservazione precedente del chiamante, e quando quell'osservazione
  era limitata o filtrata non aveva mai riportato il resto della pagina — quindi ogni
  elemento al di fuori di essa veniva elencato come "changed or new". Compilare tre caselle di un
  modulo rispondeva con quindici elementi, e digitare una parola di ricerca rispondeva con
  centoquarantasei. La risposta ora tiene separato ciò che l'azione ha dimostrabilmente
  cambiato da ciò che l'osservazione precedente semplicemente non aveva coperto, e dice
  quanta parte della pagina conteneva quell'osservazione. Non viene omesso nulla in nessuno dei due casi.

- Le intestazioni di richiesta in `network` sono quelle effettivamente inviate. Chromium
  riporta prima un insieme provvisorio e aggiunge poi lingua, codifica, client hint e
  cookie, così il dettaglio di una richiesta poteva mostrare due intestazioni e far pensare che
  la pagina non avesse mai chiesto contenuti in coreano. Il secondo insieme viene unito;
  le credenziali sono ancora nominate e mai mostrate. I nomi delle intestazioni non distinguono le maiuscole
  e i due resoconti li scrivono in modo diverso, quindi l'unione mantiene una voce per
  intestazione — la grafia e il valore che sono andati sul filo — invece di elencare
  `User-Agent` e `user-agent` come se la richiesta li portasse entrambi.

- I siti vedono Browser Use come la build di Chrome che li renderizza. La stringa dell'agente
  riportava ancora la versione dell'app desktop e il runtime Electron, mentre i
  client hint ricevuti dalle stesse pagine nominavano solo Chromium; GitHub ha risposto
  a quella contraddizione con un muro di accesso su un repository pubblico. La
  partizione del browser ora presenta la semplice stringa Chrome — un'impronta in meno e
  meno deviazioni "browser non supportato" — e uno user agent emulato prevale ancora
  quando un'attività ne richiede uno.

- Le pagine che continuano ad agganciare frame possono essere di nuovo osservate. Portali e home page di notizie
  aprono slot pubblicitari e widget a raffica, e uno snapshot iniziato
  a metà raffica rinunciava con "frame topology changed during observation" —
  in modo riproducibile, al primo e al secondo tentativo. Le osservazioni non hanno effetti collaterali,
  quindi il collettore ora attende brevemente che la raffica si plachi e rilegge,
  fino a un piccolo limite, invece di consegnare al chiamante un errore per una pagina che era
  semplicemente occupata. Quando una lettura fallisce ancora, la risposta ora dice che la pagina è
  caricata e che è fallita solo la sua lettura, così il passo successivo è osservare
  di nuovo anziché abbandonare una pagina che sta bene.

- Una pagina riporta solo i propri errori. Le richieste e gli errori della console del
  documento precedente restavano nei registri, così uno snapshot di una pagina sana poteva
  elencare richieste interrotte del sito visitato prima, e `console` su una
  pagina pulita poteva rispondere con gli errori della pagina precedente — entrambi mandavano il
  lettore a caccia di un guasto che non c'era. Caricare un nuovo documento li cancella;
  navigare all'interno dello stesso documento li mantiene, perché nulla è stato ricaricato.

- Le race del display di Browser Use non sono più errori. Un'acquisizione che perde contro una
  navigazione o un ridimensionamento della finestra ora risponde con un marcatore di ricampionamento invece di
  un errore, perché il riquadro avrebbe comunque richiesto di nuovo qualunque cosa la
  pagina mostrasse dopo. La normale navigazione riempiva il log dell'app di errori
  di acquisizione — diciassette in un'esecuzione del banco di prova, ora nessuno — e un telefono associato
  segnalava la stessa race come "could not connect to browser screen"; ora
  ricampiona alla cadenza attiva e segnala solo un display che si ferma davvero
  senza fare progressi.

- Cancellazione dei dati di navigazione di Browser Use. Il riquadro del browser ha un pulsante gomma che
  rimuove la cache, i dati memorizzati dai siti su questo dispositivo e i cookie, ciascuno
  come decisione a sé: la cache è preselezionata perché perderla costa un solo ricaricamento
  più lento, mentre i cookie ti disconnettono da ogni sito e non sono mai il valore predefinito.
  Ogni ambito viene cancellato separatamente, quindi un errore viene segnalato come errore
  invece di sparire dietro gli ambiti riusciti. La cancellazione dei cookie riscrive anche
  il file sigillato che porta gli accessi di sessione attraverso i riavvii, così un
  accesso che hai cancellato non torna alla successiva apertura dell'app — e se
  quel file non può essere riscritto, i cookie vengono segnalati come non cancellati anziché
  come fatto. Finora la partizione condivisa cresceva su disco senza alcun modo di
  recuperare spazio.

- Le metriche `performance` di Browser Use riportano la memoria del processo che disegna
  la pagina, non solo l'heap JavaScript: una pagina le cui immagini e i cui livelli occupano
  la memoria prima sembrava piccola. La lettura nomina il processo, poiché un solo
  renderer può disegnare più pagine dello stesso sito.

- Il criterio di dominio di Browser Use copre le connessioni peer. Quando un operatore
  limita i domini che una pagina può raggiungere, WebRTC non aggira più il
  filtro tramite STUN e TURN: le connessioni peer vengono rifiutate nella pagina e
  in ogni frame figlio. Senza criterio di dominio non cambia nulla, e questo
  resta un contenimento per il codice della pagina e non un confine di rete.

- Screenshot di elementi in Browser Use. `snapshot mode=visual` accetta `ref` o
  `target` e restituisce quell'elemento come immagine a sé. Il riquadro viene misurato in
  pixel CSS del documento superiore — i frame dello stesso processo includono il proprio offset lato
  pagina, un frame cross-origin aggiunge il proprio offset di sessione senza l'hit
  test che protegge l'input, perché un'immagine non invia nulla e un frame
  sotto una trasformazione CSS ne merita comunque una — e il ritaglio è scalato in base al
  rapporto immagine-viewport, quindi vale
  anche su un display ingrandito o ad alta densità. Un elemento più alto o più largo della finestra
  viene ritagliato dall'acquisizione del documento anziché dal viewport, così una tabella
  o un articolo lungo arriva intero invece di terminare alla piega; solo una pagina troppo
  grande da acquisire ripiega sulla parte visibile, e lo dice. L'immagine è
  solo per ispezione: non viene mai vincolata come ancoraggio di coordinate, perché il ref
  resta il modo di agire sull'elemento. `mode=semantic`, `fullPage` e
  `format=pdf` rifiutano un target anziché ignorarlo.

- Fedeltà dell'input di Browser Use. `drag` ora completa il drag HTML5 proprio della pagina:
  l'intercettazione del drag di Chromium consegna il payload che la pagina ha avviato e
  il gesto termina come `dragEnter`/`dragOver`/`drop`, che è ciò che una card kanban, un
  elenco ordinabile o una zona di rilascio file ascoltano davvero;
  le pagine che tracciano solo eventi del mouse mantengono il percorso precedente. `type` invia un
  vero evento tasto per ogni carattere invece di inserire l'intera stringa, così
  l'autocompletamento guidato dai tasti e le combo box reagiscono, mentre i caratteri
  fuori dal layout US (coreano, emoji) vengono comunque inseriti come testo. `press`
  invia i codici tasto US per la punteggiatura (`.` era Canc, `-` era Ins),
  evita che una scorciatoia digiti un carattere, e non deduce più Maiusc da una
  lettera maiuscola, cosa che aveva trasformato `Control+A` in `Control+Shift+A`.
  `upload` rilascia file su un elemento che non apre mai un selettore di file, con una
  protezione che neutralizza un rilascio non gestito — altrimenti il browser porta
  la pagina al file rilasciato — e segnala chiaramente quando nulla lo ha accettato.

- Fedeltà dell'osservazione di Browser Use. `scroll text=` cerca nei frame e nelle shadow
  root come fanno `read` ed `expect`, sceglie una corrispondenza tra di essi, e non
  scorre più verso un elemento compresso. `expect.text` normalizza gli spazi
  all'interno di una riga ma mantiene le interruzioni di riga, così il markup indentato corrisponde mentre due
  blocchi separati non si fondono mai in una sola frase. La diagnostica della console mantiene
  ciò che una pagina ha registrato: gli argomenti oggetto arrivano come anteprima leggibile invece di
  un messaggio vuoto, le voci nominano lo script e la riga che un lettore
  aprirebbe, e un `throw` nudo non intercettato porta la sua posizione. Gli snapshot segnalano
  `aria-hidden`, una `select` nativa fallita elenca le opzioni che ha trovato, e
  `aria-labelledby` viene risolto all'interno di una shadow root.

- Browser Use conta la diagnostica che non è riuscito a includere. Il report di una pagina mostra i
  tre errori più recenti della console e di rete, che sembravano la storia completa:
  dodici errori arrivavano come tre. Il report ora indica il totale e
  rimanda a `console` o `network` ogni volta che l'elenco è limitato.

- Browser Use ammette quando un estratto di pagina si interrompe prima. Il testo visibile in uno
  snapshot è limitato, e il report diceva solo "condensed", così un articolo lungo
  sembrava un estratto che fosse l'intera pagina. Entrambi i percorsi di snapshot — l'acquisizione
  di accessibilità e il fallback DOM — ora segnalano un estratto troncato, e
  il report indica quanto ne contiene e dice che la pagina ha di più.

- Gli allegati riportano la dimensione dell'immagine che hanno effettivamente prodotto. Adattare un'
  immagine a un budget di patch per la visione rifila i bordi uno alla volta, il che può chiedere
  un riquadro che l'immagine non riempie; la versione risultante veniva quindi più piccola
  della dimensione riportata accanto, e le coordinate mappate attraverso quella dimensione
  erano sballate. Il ridimensionamento ora riporta le dimensioni dell'immagine prodotta.

- Browser Use dice dove è fallito uno script di pagina. `evaluate` manteneva solo la prima
  riga dell'errore del browser, quindi uno script di più righe riportava
  `TypeError: ...` senza nulla per localizzarlo. L'errore ora porta con sé il frame
  di stack più interno, e il banco di prova di integrazione fissa la posizione
  che riporta un throw su una riga successiva.

- Browser Use nomina un PDF invece di segnalare una pagina vuota. Aprire un link
  a un PDF registrava l'indirizzo, ma il guest non ha un visualizzatore per esso, quindi lo
  snapshot mostrava una pagina senza titolo né testo e rumore di console su un foglio di stile del
  visualizzatore bloccato — nulla che dicesse cosa fosse successo. Il report della pagina
  ora dichiara che il documento è un PDF che questo browser non può visualizzare e che
  il file va letto dal suo URL, e gli errori che i componenti inclusi di Chromium sollevano per le loro risorse `chrome-extension://`
  non compaiono più come errori di console o di rete della pagina. Il banco di prova di integrazione
  copre la navigazione, il report silenzioso e un successivo snapshot della pagina.

- Browser Use smette di far rimbalzare `close_tab` sulla scheda visibile. `list_tabs`
  stampa la pagina visibile con un normale id di pagina, quindi puntarvi `close_tab`
  veniva risposto con `unknown background tab "p12"; call list_tabs` — l'elenco
  che aveva fornito l'id. Il rifiuto ora dice che la pagina appartiene al
  pannello del browser e suggerisce di navigarla altrove oppure `hide`, mentre
  nomi non correlati continuano a segnalare una scheda in background sconosciuta.

- Browser Use dice cosa ha davvero fatto una conferma di uscita. Una pagina che protegge
  lavoro non salvato fermava una navigazione con una finestra `beforeunload`, e la
  risposta chiedeva `handle_dialog` — ma Chromium risponde da sé a quella conferma,
  quindi la chiamata tornava sempre "no JavaScript dialog is currently
  open" mentre ripetere la navigazione ripeteva la stessa istruzione. La
  risposta ora dichiara che la navigazione è stata abbandonata e la pagina è rimasta,
  che non c'è più nulla a cui rispondere, e che il lavoro contenuto nella pagina
  va prima completato o scartato; il banco di prova di integrazione contiene l'intera
  sequenza, compresa la navigazione che passa una volta rimossa la protezione.

- L'emulazione della lingua in Browser Use raggiunge il server. `emulate locale` impostava
  solo `navigator.language`, così la pagina continuava a chiedere la vecchia lingua
  e i siti negoziavano contenuti che l'emulazione contraddiceva; ora porta
  la lingua anche come `Accept-Language`, e cancellarla ripristina la negoziazione propria
  del browser.

## v0.9.171 - 2026-09-18

- Recupero del rilascio: l'artefatto di staging del relay di produzione è identificato dalla sola
  esecuzione (`production-relay-<run_id>`) e viene caricato con `overwrite: true`. Il
  nome portava il tentativo di esecuzione, ma una riesecuzione parziale preserva il job riuscito
  `stage-production-web-relay` mentre riesegue
  `deploy-production-web-relay` come dipendente del job fallito, quindi l'artefatto
  legato al tentativo non esisteva mai e il deploy moriva con "Artifact not
  found" prima di poter raggiungere la produzione. È esattamente così che v0.9.170
  ha pubblicato la sua release GitHub e il pacchetto npm senza distribuire il relay
  web. `overwrite: true` evita che una riesecuzione completa, in cui il job di staging
  viene eseguito di nuovo, entri in collisione con l'artefatto del tentativo precedente, e
  il gate di rilascio verifica sia il nome sia l'overwrite.

## v0.9.170 - 2026-09-17

- Consolidamento del prompt di sistema. Ogni regola ora ha un solo proprietario: il livello
  condiviso (`rules/shared/*.md`) è solo policy degli strumenti e si apre con
  `# Tool Calls` (prima il batching; `05-parallel-calls.md`), il ruolo Lead è
  un solo file (`rules/lead/LEAD.md`: comunicazione con l'utente, briefing degli agenti e
  notifiche di completamento dietro `<!-- tools: agent -->`, tono), e il
  contratto comune degli agenti è un solo file (`rules/agent/AGENT.md`: catena di
  comando, nessuna auto-verifica, inglese, forma della consegna). `00-general.md`,
  `02-persona.md`, `lead-brief.md`, `00-core.md`, `00-common.md` e
  `75-goal.md` non esistono più — le loro frasi sopravvissute sono passate al file che
  le possiede, e le frasi che la descrizione di uno strumento già enuncia (`load_tool`,
  `Skill`, `goal`, approvazione di `memory`, `task wait`, outline di `code_graph`,
  forma della chiamata read, instradamento Git, instradamento browser/computer) sono enunciate lì
  soltanto. La precedenza è per ruolo: l'ultima richiesta esplicita dell'utente per Lead,
  l'ultimo brief di Lead per gli agenti. La regola del preambolo di Lead ora porta
  il suo motivo (l'utente vede solo il tuo testo) e chiede una riga, non un conteggio
  di parole; la regola del briefing dice che un agente non vede mai la conversazione, che
  i risultati vengono sintetizzati in percorsi, righe e nell'esatta modifica ("based
  on your findings" mai), e che il risultato di un agente non viene mai previsto.
  Le regole sulle azioni distruttive che erano distribuite su quattro sezioni stanno in una sola
  sezione `# Destructive Actions`. I file di ruolo (`agents/*/AGENT.md`) eliminano le
  frasi su blocco/consegna che il contratto possiede; `maintainer` ottiene frontmatter con nome e
  descrizione. Stili di output: l'intestazione `## Depth` sostituisce
  `## Depth Variation`, e la formulazione dei report di avanzamento vive solo nelle regole di Lead.
  Il workflow Default non porta più il paragrafo del revisore di fallback;
  viaggia con il blocco della modalità di orchestrazione che le modalità di delega
  iniettano. Descrizioni degli strumenti: `edit` non rimanda più a `apply_patch`
  sulle superfici che lo hanno filtrato, `shell` dice che Git va a `git` solo quando
  quello strumento è presente, `read`/`grep` eliminano i limiti di byte che il runtime riporta
  comunque, `code_graph` dichiara che `symbols` è l'outline. I provider che
  consegnano da soli il promemoria del round (`anthropic-oauth` come messaggio di
  sistema limitato al turno, `cursor` tramite il suo relay) dichiarano `deliversRoundReminder`
  così il canale del runtime resta silenzioso — le sessioni Cursor non ricevono più il
  promemoria del batching due volte per round. Il controllo di provenienza del suggerimento di batching
  normalizza i separatori di percorso e accetta una directory mostrata come prefisso di un
  percorso più profondo nel risultato precedente, così una chiamata successiva su un percorso che l'ultimo
  risultato aveva rivelato non viene più letta come una chiamata singola non correlata (due
  falsi positivi per sessione prima). Lo schema di route di `setup` dichiara
  `contextPercent` come intero limitato (l'esecutore richiede ancora un
  multiplo di 10) così Gemini smette di ricevere un segnaposto di enum non
  rappresentabile. Le aspettative dei test obsolete rimaste dal commit sul batching
  sono state aggiornate, e due test dipendenti da tempi/ambiente sono resi
  deterministici. La skill di progetto `gamerscroll-article` è limitata al
  suo progetto.
- Le release GitHub ora portano come note la sezione CHANGELOG.md della versione,
  seguita dal link di confronto; la bozza prima si affidava alle note
  generate da GitHub, che elencano solo le PR unite e lasciavano la pagina
  con un semplice link `Full Changelog` perché Deploy committa direttamente su main.
- Batching degli strumenti: dopo tre round di chiamata singola dello stesso strumento di fila le cui
  chiamate non dipendevano l'una dall'altra (nessun argomento preso dal risultato precedente,
  nessun passo ordinato dopo una mutazione; uno strumento diverso riavvia la serie, così
  read → shell → apply_patch non viene mai segnalato; le attese di task, Computer Use,
  i passi del browser e i caricamenti di schema/skill non contano mai), oppure un
  round di chiamate dello stesso strumento che differiscono solo per un campo array, il runtime aggiunge un
  breve `<system-reminder>` che nomina gli argomenti array sulla superficie di strumenti
  della sessione; si ripete ogni volta che il pattern si ripresenta e solo un round
  in batch lo cancella (tracciato come `batching_nudge`). Un `read` di un singolo file subito dopo
  un round grep/code_graph/glob/find che ha localizzato più file riceve
  l'insieme localizzato nella forma che accetta una chiamata `read`
  (`[{file_path, offset, limit}, …]`; una read per file nella stessa risposta
  sui provider il cui schema read accetta solo stringhe di percorso), tracciato come
  `located_sites`: una sessione registrata di Gemini 3.8 Flash localizzava i file con
  grep 13 volte e li leggeva comunque una finestra alla volta (63 letture, 20 su
  28 file letti due volte o più). Le descrizioni di `read` e `grep` ora dicono
  cos'è il batch — ogni file e intervallo che toccherai, prima di modificare,
  in una sola chiamata — e il piè di pagina della lettura a finestre chiede una sola lettura più ampia
  invece della finestra successiva. Le regole condivise ora enunciano l'ordine di lavoro sui file
  una volta sola (`# Tool Calls`: enumera solo quando l'ambito è ignoto → localizza
  ogni sito → una fase di lettura di finestre `{file_path, offset, limit}`, ≤10 per
  chiamata → ogni modifica in una risposta → una verifica) ed eliminano le
  frasi che prima ne dicevano parti in tre posti; le descrizioni di `read`,
  `grep`, `edit`, `apply_patch` e `code_graph` si riducono a quel
  contratto (code_graph da ~150 a ~90 parole), e il marcatore smart-cap di una lettura a finestre
  nomina la forma delle finestre localizzate; un ulteriore passaggio riduce
  la prosa dei parametri che ripeteva le regole o dettagli interni (`Skill`,
  `find`, `cwd`, `git`, `code_graph.mode`, `grep.path`/`text`,
  `include_noise`, il cheat PowerShell di shell e `timeout_ms`) — la superficie
  di strumenti di Lead scende da 13.4 KB a 12.7 KB. Esecuzioni GPT-5.6 su otto task prima
  e dopo restano a 8/8 con lo stesso ambito di round, tempo e costo; l'
  unica regressione trovata lungo la strada (un round di backup per input di sola lettura e
  rassegne `git log` dopo che due clausole di protezione erano state tagliate) è ripristinata. La
  regola di backup ora dice dove va la copia — nella stessa risposta della prima
  ispezione, mai in un round a sé — perché "inside the first inspection
  call" faceva aprire a GPT-5.6 2.8 round di solo backup per esecuzione di otto task quando la
  prima ispezione era una chiamata `read` o `git`; con la formulazione corretta non
  ne ha aperto nessuno e ha messo in batch ogni backup con quell'ispezione. Il
  promemoria seriale non tratta più un array dentro una singola chiamata come un batch: una
  revisione registrata di Gemini 3.8 Flash eseguiva quindici round di una sola chiamata, alternando
  chiamate `git` di uno e due comandi, e non lo meritava mai perché ogni round
  con array azzerava la serie. Il controllo di provenienza ora ricorda anche sei round
  invece di due, così un elenco di file da `git diff --name-only` percorso un elemento
  per round non fa più passare ogni elemento come qualcosa che il diff precedente
  aveva rivelato. Altri due promemoria del runtime:
  `late_locating` (una ricerca dopo una lettura che non ne ha preso nulla) e
  `located_sites` che consegna una finestra per sito localizzato —
  comprese le righe `(Lstart-end)` di code_graph — suddiviso in più chiamate read
  oltre dieci. I file di policy delle route
  (`rules/routes/*.md`) ora dichiarano anche un `turn-reminder:` di una riga (letto
  una volta nel blocco `<system-reminder>` finale del turno utente, prima della
  prima risposta del turno) e un `round-reminder:` di una riga accanto alle loro
  regole statiche; il ciclo dell'agente risolve quest'ultimo per provider/modello e
  raggiunge il modello dopo ogni round di strumenti — come messaggio di sistema limitato al turno di Anthropic
  (`clear_at: next_user_message`) su `anthropic-oauth`, il
  pattern che Anthropic documenta per Claude Fable 5.1, oppure come
  `<system-reminder>` del runtime dopo i round di chiamata singola altrove (`per_round`). Il
  promemoria per Fable 5.1 passa da una costante di provider codificata ai
  file di route; le cronologie registrate con la frase precedente la riproducono
  byte per byte. Un solo file, `routes/common.md`, porta i promemoria di batching
  per ogni route (un file senza restrizioni è la base; un file che nomina
  `models:` o `providers:` aggiunge a quella riga per le sue route anziché
  sostituirla) —
  Gemini procede con una chiamata per round una volta arrivati i risultati degli strumenti, Grok
  mette in batch le chiamate ma non ha mai usato argomenti array: i suoi schemi di strumenti appiattiti
  tenevano solo il ramo scalare di ogni campo uno-o-molti
  (`read.file_path`, `grep.pattern`, `git.command`, …). L'appiattimento per Grok
  ora mantiene il ramo array di tali campi (un valore viaggia come array
  di un elemento) e lo dice nella descrizione del campo, così il
  contratto di batching vale anche su quel provider. Le regole condivise ottengono una
  sezione `# Parallel Tool Calls` che enuncia chiaramente il contratto (le sessioni registrate di
  Gemini 3.8 Flash emettevano una chiamata per round in 105/105 round;
  con la sezione in vigore un'esecuzione headless ha messo in batch quattro file e git in
  una risposta). Le regole legate a provider/modello vengono caricate da `rules/routes/*.md`
  tramite il frontmatter `providers:` / `models:` e vengono rese dopo le regole
  condivise in BP1.
  `MIXDOG_ANTIGRAVITY_DUMP_DIR=<dir>` scrive ogni corpo di richiesta Antigravity
  (contenuti, strumenti, config; mai intestazioni o token) per l'ispezione del wire,
  la controparte Gemini di `MIXDOG_OAI_WS_DUMP_DIR`; `mixdog exec` passa inoltre
  `MIXDOG_XAI_CACHE_TRACE` e `MIXDOG_XAI_RESPONSES_CACHE_SCOPE`
  per le sonde della cache xAI.
- Le richieste xAI Responses non inviano più per impostazione predefinita un `prompt_cache_key` per sessione
  (`MIXDOG_XAI_RESPONSES_CACHE_SCOPE` ora ha come valore predefinito `none`, il corpo letterale di Grok
  Build): la chiave di sessione divideva la cache del servizio in corsie
  e misurava due round freddi per esecuzione contro uno, e nessun riutilizzo del
  prefisso tra sessioni. `session` e `prefix` restano selezionabili.
  `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED` sostituisce la modalità di
  function calling di Antigravity per le esecuzioni A/B, e
  `benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs` riporta
  le percentuali di chiamate multiple e di argomenti array per modello da `agent-trace.jsonl`.
- `mixdog exec` associa l'account OAuth selezionato nel pool provider-accounts
  dell'host (la credenziale che l'accesso scrive oggi), ripiegando sul
  singolo file di credenziali legacy; prima era accettato solo il file legacy o un
  `*_CREDENTIALS_PATH` esplicito, quindi gli host con solo pool fallivano con
  "credentials are unavailable". `mixdog exec` inoltre non resta più 2–4 minuti
  dopo la sua risposta prima di emettere `result`: la rimozione della radice pristine
  veniva ritentata su Windows per l'intero budget rmSync (50 tentativi lineari ≈ 128s, due volte quando
  il percorso del postmaster la rieseguiva) mentre l'handle SQLite del registro di utilizzo e il `pg.log` di un
  daemon di memoria in chiusura erano ancora aperti. Il registro viene chiuso
  prima della rimozione ed exec passa un budget di 10 tentativi (≈5.5s)
  (`cleanup({ rootRemovalRetries })`); una radice residua viene lasciata alla
  scansione periodica degli orfani anziché al chiamante.

## v0.9.169 - 2026-09-16

- Code Tidy: Install ora scarica i motori principali (Biome, ruff, shfmt,
  shellcheck, PSScriptAnalyzer) con avanzamento, e la scheda integrata elenca
  ogni motore con la sua versione, linguaggio, origine e dimensione; i motori raccolti
  in seguito da un progetto compaiono nello stesso elenco. I motori mancanti al momento del tidy
  vengono scaricati automaticamente per impostazione predefinita (`tidy.downloads` rispetta ancora `ask` e
  `never`). PSScriptAnalyzer è un download gestito verificato con sha256 dalla
  PowerShell Gallery anziché un modulo solo host, e C# ottiene un vero runner
  dotnet-format. Correzioni: le intestazioni diff di rustfmt 1.9 e i percorsi `\\?\` vengono
  analizzati, i report Biome di grandi dimensioni non collassano più a zero riscontri quando
  l'output è suddiviso in blocchi, la correggibilità viene classificata tramite `biome explain`, e
  la regola dei commenti di cronologia rimuove solo i commenti interamente di cronologia
  e non si estende mai oltre il commento (poteva eliminare l'istruzione successiva).
- Le righe della barra laterale condividono un unico tag di stato accanto al titolo per integrati,
  plugin, skill, server MCP, pianificazioni, webhook e agenti: nulla quando
  abilitato, altrimenti `Not used`, `Not installed`, `Installing… N%`, `Failed`
  o `Not connected`. Gli agenti disabilitati mantengono la loro riga del modello.
- FastDirect rifiuta di riconfezionare o installare un `app.asar` la cui chiusura delle
  dipendenze di produzione è incompleta e ripiega su una build completa, così un
  updater rotto (`Cannot find module 'graceful-fs'`) non viene più ereditato
  da ogni aggiornamento incrementale.
- I worker degli agenti che sono stati eliminati non vengono più resuscitati dalle scansioni delle sessioni
  o dall'elenco agenti del desktop; le sessioni concluse registrate di nuovo mantengono il
  loro vero orario di fine, così i lease scadono invece di ripartire ogni ora.
- Le modalità di orchestrazione `none`, `focused`, `balanced` e `swarm` sostituiscono il
  workflow Solo e si scelgono per sessione; le impostazioni sono localizzate.
- Desktop: i link a percorsi locali nel markdown si aprono nell'editor, e l'editor
  apre file al di fuori del progetto.
- Browser Use serializza gli snapshot per pagina e rafforza i percorsi di attesa e
  acquisizione.
- Computer Use: un renderer di overlay congelato viene ritirato e sostituito, lo stato
  di recupero dell'input sopravvive al cambio, e le fixture dell'overlay non terminano più
  in anticipo su una macchina con un solo display.
- Shell: gli host PowerShell non bloccano più in modo rigido `grep`, `sed` e `awk` nel
  preflight; la descrizione dello strumento instrada invece il lavoro verso gli strumenti dedicati. Regole,
  skill, README e il nuovo `docs/context-efficiency.md` sono aggiornati.
- Il repository è formattato con Biome 2.5.13 (`biome.json` fissa lo
  stile esistente), rustfmt, dotnet-format e PSScriptAnalyzer; import inutilizzati,
  helper morti ed export usati solo nel file sono rimossi.

## v0.9.168 - 2026-09-16

- La chiusura di una sessione Computer Use invia sempre la propria richiesta di rilascio. Il
  rilascio speculativo del timer di inattività veniva ereditato quando era ancora
  in corso, così un rilascio anticipato rifiutato poteva lasciare i claim del worker e della
  finestra della sessione in chiusura bloccati fino al riavvio dell'app.

- Overlay di Computer Use: due controlli, Stop e Riprendi. Il pulsante di pausa
  non c'è più (toccare il desktop cede già il controllo all'utente); la pillola ora
  mostra perché un controllo non è disponibile o perché una richiesta è fallita invece di
  reagire in silenzio. Stop ripristina un errore di pulizia bloccato una volta che ogni worker
  di input è terminato, così l'host non richiede più un riavvio dell'app, e
  la conferma di uscita del worker attende fino a 5 secondi invece di 1.
- Computer Use cattura una finestra dalla propria superficie renderizzata anziché
  copiare il desktop, con un budget di cattura limitato; un rilascio di risorse non
  confermato ritira quel worker. Tastiera e digitazione in background vengono controllate
  prima che venga inviato qualsiasi input, così un percorso non supportato non fa nulla. Un nuovo
  comando attende finché il rilascio della sessione precedente non è confermato. Stop attende anche
  l'annullamento del turno dell'agente, indipendentemente dalla pulizia dell'input nativo.
- Le attese di Browser Use rispettano l'annullamento e rifiutano di mescolare un URL con il testo di un
  documento successivo; un ripristino fallito dopo lo screenshot a pagina intera è terminale. I selettori
  CSS mantengono gli spazi interni, rifiutano insiemi di corrispondenze troppo grandi e
  indirizzano ogni corrispondenza in modo univoco. I download concorrenti condividono un unico totale
  di byte di sessione; le richieste di approvazione descrivono azioni e indirizzi, mai i valori dei moduli.
- Code Tidy è un integrato installabile, come Office: Impostazioni → Integrati
  lo installa e lo attiva, e la skill `code-tidy` guida lo strumento `tidy`.
  Scan rileva i linguaggi di un progetto e risolve ogni formatter o linter
  dalla configurazione del progetto, poi dai binari locali al progetto, da PATH, o da un download
  gestito verificato con sha256 (ask, auto o never). Esegue Biome, ruff, clang-format,
  shfmt, shellcheck, StyLua, gofumpt, dprint, Air e Mago, oltre a
  rustfmt, gofmt e PSScriptAnalyzer della toolchain, e applica pacchetti strutturali
  (rimozione dei commenti di cronologia, `debugger`, catch vuoti, marcatori TODO) su 31
  linguaggi. `fix` è un dry-run a meno che non sia impostato apply, e le scritture passano per la
  stessa pipeline delle altre modifiche. Le licenze dei motori sono incluse con lo strumento.
- I chiamanti e i chiamati di `code_graph` provengono da siti di chiamata analizzati, non dalla ricerca
  testuale; anche i riferimenti a forma di chiamata usano quei siti. Un binario del grafo più vecchio
  che non può emetterli fallisce con un rimedio di ricostruzione invece di una risposta vuota.
  Le righe dell'outline usano un unico vocabolario di tipi, segnano gli export, mostrano le
  firme e annidano i membri sotto il loro genitore. `find_symbol` preferisce un file di
  implementazione a un `.d.ts` di accompagnamento e segnala quando la
  dichiarazione si trova al di fuori dei file richiesti. I token degli identificatori provengono dal
  parse tree, quindi un nome che compare solo in un commento non conta più
  come riferimento. Solidity, Haskell e HCL entrano nell'insieme di estrazione con
  archi di import (24 linguaggi di estrazione, 31 analizzati). I dati dei siti di chiamata vivono in
  una cache sidecar così la cache principale del grafo mantiene la stessa dimensione.
- Il binario nativo del grafo incorpora tree-sitter 0.27 e ast-grep 0.45.3, aggiunge le
  modalità `--scan`, `--langs` e `--outline`, ed estrae simboli, import
  e token di identificatori dalle regole YAML.
- L'outline di fallback del grafo dell'editor desktop analizza le nuove righe di simboli in
  un outline annidato con icone dei tipi.
- Le domande sulla struttura (export, firme, membri, chiamanti, importatori) vanno
  a `code_graph` prima di `read` o `grep`; la formulazione sul parallelismo del flusso
  di lavoro degli strumenti è una sola regola.
- La manutenzione della memoria non promuove più i riepiloghi delle conversazioni a
  istruzioni permanenti: non esiste un terzo ciclo. Il ciclo 2 rivede la cronologia delle ricerche per
  duplicati e discendenza senza riscrivere i riepiloghi. La memoria permanente resta
  curata dall'utente tramite `memory`; `recall` cerca per impostazione predefinita in tutta la cronologia,
  comprese le righe archiviate in precedenza.
- L'utilizzo di Antigravity Gemini mostra le finestre condivise di 5 ore e settimanali dal
  riepilogo della quota dell'account, non dai contatori del catalogo per modello, e le richieste usano
  il canale giornaliero senza failover automatico dell'host.
- Il riquadro Agenti espande solo le righe che apri, mostra un conteggio dei discendenti su
  lead, e dice "Waiting for agents" finché i discendenti stanno ancora
  lavorando invece di trattare il genitore come inattivo o completato.
- Il composer offre una piccola tavolozza di comandi slash per i comandi frequenti
  (`/new`, `/model`, `/compact`, `/context`, `/goal`, `/inherit`, `/fast`);
  il registro completo continua a funzionare quando digitato direttamente.
- Le menzioni di file nella conversazione restano testo semplice finché il percorso non è confermato
  nel Progetto proprietario; cartelle e documenti si aprono ancora nel sistema operativo, e le
  aperture nell'editor passano un token di accesso.
- L'elenco di utilizzo nella barra laterale allinea etichette dei provider, contatori, percentuali e
  orari di azzeramento su un'unica griglia; il catalogo dei modelli mantiene sette recenti.
- Una nuova sessione attende che i salvataggi delle impostazioni in sospeso finiscano, e gli strumenti MCP
  usciti dal catalogo corrente non vengono chiamati a metà turno.

## v0.9.167 - 2026-09-15

- L'avvio della sessione riporta quali strumenti shell comuni sono presenti ("Shell tools
  at startup"), misurati nella shell di login su POSIX e nel PATH del processo
  su Windows, così un modello non indovina più `python` contro `python3` né chiama
  `file` dove è assente; una risposta sconosciuta non rende nulla.
- `read` rende una sola volta le finestre sovrapposte di un file, non riporta più
  gli intervalli di modifica non letti come già consegnati, e non eredita mai un
  contrassegno obsoleto di corpo-intero-consegnato dopo che un file cambia; le letture array rispettano la
  loro opzione no-stub e la descrizione indica i reali limiti di output.
- `git` esegue i comandi concatenati con `&&` come array ordinato (fino a 10) invece di
  rifiutarli, e riconosce i repository bare.
- La cache di lettura della sessione rispetta l'allowlist degli strumenti, rileva le modifiche di solo `ctime`,
  non memorizza mai un corpo catturato prima di una modifica a metà lettura, tiene separati
  i suggerimenti di offset pubblici e legacy, e copre le letture array pubbliche.
- Gli array di `web_search` mantengono segnalati come errori i fallimenti parziali e totali.
- Le regole e le descrizioni degli strumenti integrati sono più brevi con lo stesso comportamento: la
  descrizione di `shell` porta la mappa comando→strumento e vieta i nomi degli strumenti come
  comandi shell; la guida su `timeout_ms` copre i controlli usa e getta; la guida a Lead
  che vale solo con lo strumento `agent` è omessa dai workflow senza delega;
  le regole chiedono ogni azione indipendente che le prove attuali
  richiedono in una sola risposta, di applicare patch direttamente da prove decisive, un
  campione prima della logica di parsing e porzioni limitate per dati grandi o binari.
- Il runtime desktop è sincronizzato con il lavoro corrente sull'harness di browser e computer,
  e i test di contratto degli strumenti sono rafforzati di conseguenza.

## v0.9.166 - 2026-09-14

- Studio riconosce l'account ChatGPT selezionato dopo l'accesso al provider e i
  cambi di account, usando lo stesso percorso di credenziali della chat senza ripiegare
  sulle credenziali di un altro account.

## v0.9.165 - 2026-09-14

- Il dock di Source Control mantiene la sua finestra di righe legata all'elenco attivo: un
  dock ricostruito (cambio di scheda, dalla superficie di primo avvio all'elenco) non scorre più verso
  righe vuote.
- Gli asset di rilascio macOS vengono caricati tramite lo script elimina-poi-riprova su entrambe le
  architetture, così un'esecuzione di recupero non fallisce più su un asset già
  esistente nella bozza nascosta.
- Gate di rilascio: ogni corsia passa in verde sui runner ospitati. Linux installa
  NanumGothic per i PDF in Hangul e l'attuale LibreOffice per le revisioni
  renderizzate; il controllo del cursore su Windows fissa la sua preferenza di movimento;
  le aspettative dei test seguono i contratti distribuiti.

## v0.9.164 - 2026-09-14

- Compattate le regole condivise e di Lead e le descrizioni degli strumenti integrati con lo
  stesso comportamento in meno token; la descrizione di `shell` mantiene solo il suo ruolo,
  il confine con gli strumenti dedicati a file/ricerca/Git e il contratto dei task
  in background.
- Le esecuzioni headless (`mixdog exec`) dichiarano che nessun utente interviene a metà esecuzione: la
  richiesta è trattata come approvata e portata a termine prima di riferire,
  invece di fermarsi a porre una domanda a cui nessuno può rispondere.
- `apply_patch` digitato nella shell non viene più reindirizzato al motore
  delle patch; il modello chiama `apply_patch`/`edit` direttamente.
- Un Obiettivo fermato si ritira come uno completato: il prompt successivo dell'utente
  lo archivia, e confermare un arresto lo archivia subito.
- Le statistiche di utilizzo attribuiscono token e costo misurati per richiesta nel registro,
  e l'explorer di utilizzo del desktop mostra la ripartizione risultante.
- Correzioni al wire del provider Cursor.

## v0.9.163 - 2026-09-10

- Rifinita la localizzazione dell'interfaccia, la selezione della lingua all'avvio, i menu nativi e
  la formattazione tradotta; mantenuto aggiornato il bootstrap della lingua web tra gli aggiornamenti.
- Rafforzati la proprietà dell'input di Computer Use e i controlli di sola osservazione, confermati
  i target di testo Electron prima di digitare, e migliorata la gestione di cursore e sessioni.
- Migliorate la ricerca nativa dei file e le letture a intervalli, ed evitato che calcoli in corso
  invalidati o annullati ripopolino la cache dei risultati.
- Inclusi benchmark di ricerca, copertura di regressione, audit di localizzazione e
  deliverable di progetto e documenti generati.

## v0.9.162 - 2026-09-09

- La finestra Imposta un obiettivo si apre centrata nel riquadro il cui composer l'ha sollevata,
  oscurando solo quel riquadro; i riquadri vicini restano visibili e utilizzabili e la barra del
  titolo non viene più oscurata. Fuori da un riquadro ripiega sul livello della finestra.
- Un riquadro in primo piano non copre più la maniglia di divisione sul proprio bordo: un riquadro
  del browser (o qualsiasi riquadro in primo piano) può di nuovo essere ridimensionato dal bordo sinistro/superiore.
- Web fetch riporta una fase che scade alla scadenza totale come
  `FETCH_TIMEOUT` invece di `STAGE_TIMEOUT`.
- Computer Use usa per impostazione predefinita la consegna in background per l'input semantico supportato;
  `foreground_unavailable` ora chiede all'utente di attivare la finestra di destinazione
  invece di descrivere un errore di blocco del primo piano.
- L'esecuzione di rilascio v0.9.162 si è fermata al gate dei test e non ha distribuito nulla; le sue
  note qui sotto sono consegnate da questo rilascio.

- Mixdog è ora distribuito con licenza Apache-2.0 invece di MIT. I componenti di terze parti
  mantengono le loro licenze esistenti e le note di attribuzione.

- Browser Use e Computer Use chiedono una volta per sessione prima della loro prima chiamata
  live. La prima chiamata `browser`/`browser_devtools` o `computer` che un modello effettua
  in una sessione passa per la richiesta di approvazione dello strumento con l'azione che vuole
  compiere; consentirla copre il resto della sessione, rifiutarla restituisce il
  motivo al modello con l'istruzione di non riprovare, e un riavvio chiede
  di nuovo. Le sessioni senza interfaccia di approvazione (headless, di proprietà di un agente) non sono soggette a questo controllo.
  `setup set_first_use_approval name:browser|computer enabled:false` lo disattiva
  per singola capacità, e `MIXDOG_BRIDGE_FIRST_USE_APPROVAL` lo sostituisce per
  processo.

- Browser Use accorpa due gesti in quelli vicini. Una casella di controllo o un
  pulsante di opzione si imposta con `fill` con `checked` invece di `text` — per un solo controllo,
  un elemento di `fields` o un passo di `sequence` — così l'azione separata `check` non
  esiste più; e `forward` non esiste più, poiché lo snapshot precedente mostrava già
  l'URL a cui fare `navigate` mentre `back` resta un gesto. `locate` ed `extract`
  restano: il primo è una ricerca visiva (a pixel) senza equivalente semantico, il
  secondo legge righe attraverso frame e shadow root aperte che `evaluate`
  non può raggiungere.

- `capture` di Computer Use elimina le opzioni `quality`, `maxWidth` e `max_ocr_words`:
  si applicano i valori predefiniti ottimizzati dell'host (qualità JPEG, larghezza di riduzione e un
  limite di parole OCR che il budget degli elementi già limita), e il dettaglio illeggibile è
  uno `zoom` anziché una ricodifica. I filtri degli elementi (`query`, `role`,
  `visible_only`, `include_noninteractive`, `continuation`) e la geometria di movimento di
  `window` ora dicono cosa fanno invece di viaggiare nello schema senza spiegazioni.

- Browser Use e Computer Use dichiarano il loro gradino della scala degli strumenti dove il
  modello decide. La descrizione di `browser` si apre con "last resort: prefer
  web_fetch, an MCP tool, or a CLI in shell", `computer` con "last resort
  after an MCP tool, shell/CLI, and Browser Use; never a stand-in for a page
  action browser refused", e le regole condivise e entrambe le skill portano la stessa
  scala, così un servizio che ha un'API o una CLI viene raggiunto tramite essa invece che tramite
  uno schermo. Nessuna descrizione è cresciuta: la scala ha sostituito formulazioni che le skill
  possedevano già.

- Browser Use è composto da due strumenti. `browser` mantiene il lavoro quotidiano sulle pagine — navigate,
  snapshot, read, click, fill, moduli, finestre di dialogo, schede, download, letture di console e
  rete — mentre i controlli per sviluppatori `emulate`, `cookies`,
  `storage`, `intercept`, `init_script` e `performance` passano allo strumento
  differito `browser_devtools`, che pilota le stesse pagine e lo stesso accesso e
  carica il suo schema alla prima chiamata. Lo schema quotidiano elimina i 33
  campi usati solo da quelle azioni (attributi dei cookie, geolocalizzazione, limitazione della CPU,
  corpi di intercettazione, opzioni di trace), le note dei campi di ciascuno strumento nominano
  solo le sue azioni, e una chiamata che raggiunge lo strumento sbagliato viene rifiutata
  indicando lo strumento da chiamare. L'host, il suo registro delle azioni, il criterio di approvazione e
  il banco di prova di integrazione mantengono l'unico contratto di azioni condiviso.

- Gli schemi degli strumenti integrati dichiarano solo contratti. Le descrizioni e le note dei campi degli strumenti `office`, `computer`,
  `media` e `setup` eliminano le frasi di metodo e
  criterio che le loro skill già possiedono — batching, quando fare snapshot o
  `describe`, correggere un audit nello stesso turno, riuso di `design.content`, gestione
  delle macro, do-not-rearrange, contenuto dello schermo che non autorizza mai un'azione,
  polling dei video, la procedura di approvazione delle eliminazioni — il che rimuove circa 2.2 KB
  (office −878 B, computer −492 B, media −432 B, setup −424 B) dalla superficie
  degli strumenti inviata a ogni turno. Le skill pptx, xlsx e pdf ora portano le
  regole che vivevano solo nello schema (un batch di operazioni note,
  `describe` solo per un campo sconosciuto, contenuto del documento non attendibile), e la
  skill computer-use enuncia il contratto di chiamata una volta sola invece di ripetere ogni
  frase dello schema.

- Browser Use richiede meno chiamate per attività. `click`, `fill`, `type`, `select`,
  `hover`, `upload` e `scroll` — e ogni elemento di `fill.fields` e ogni passo di
  `sequence` — accettano un `target` senza snapshot (`{role, name}`, `{name}`,
  o `{selector}`) invece di un `ref`: l'host osserva da sé la pagina,
  agisce solo su una corrispondenza esatta (più corrispondenze di sottostringa si risolvono in quella
  letterale unica), e un target ambiguo fallisce con i candidati e
  i loro ref aggiornati. `query` su `snapshot`, `read` e `wait` abbina
  parole chiave separate da spazi con OR (le corrispondenze con tutte le parole chiave vengono prima)
  e accetta espressioni regolari `/pattern/i`, e un filtro che non trova nulla dice
  quanti elementi o caratteri stava filtrando. I controlli trasparenti o con
  pointer-events:none non vengono più rifiutati di netto: una casella nascosta
  viene cliccata tramite la sua etichetta, e la protezione del target di input accetta
  l'attivazione dell'etichetta. `fill` su un editor `contenteditable` sostituisce il
  contenuto come input digitato dopo una selezione totale anziché sovrascrivere il suo DOM.
  Le risposte annotano "No observable change" quando un gesto ha lasciato intatti documento, URL
  e valori dei controlli, `brief:true` elenca solo gli elementi nuovi
  o cambiati dall'osservazione precedente, gli errori della console vengono riportati una volta
  quando nuovi, e una postcondizione che già valeva è un avviso anziché un
  errore. Gli snapshot contrassegnano gli input di file con `file-input`, `accept=…` e
  `multiple`; gli screenshot a pagina intera ancorano nel flusso gli elementi fissi e sticky
  per l'acquisizione; e i cookie di sessione sono memorizzati cifrati con il
  portachiavi del sistema operativo e ripristinati all'avvio, così gli accessi sopravvivono a un riavvio dell'app.

- Il chrome sopra l'input del prompt — capsula Obiettivo, avanzamento del runtime, approvazione
  degli strumenti, barra del contesto della bozza e slot di revisione del turno — ora vive in un solo
  `ComposerDock`, e la trascrizione non ondeggia più quando quel chrome si risolve:
  lo slot di revisione resta riservato mentre la prima lettura autorevole del worker per un ambito
  è in corso, così un diff che arriva dopo che la trascrizione è mostrata riempie la
  geometria esistente invece di ridimensionare di nuovo il viewport. Lo spazio liberato non
  viene mai trattenuto da un timer. L'host desktop smette inoltre di rileggere un'intera
  sessione dopo ogni prompt accettato (il recupero "missing baseline" del
  log del daemon): un frame di risposta o di corsia che ripete la revisione che la
  proiezione già detiene è stato applicato, non una baseline incrociata. I
  flip di montaggio/smontaggio della capsula Obiettivo sono attribuibili con `MIXDOG_DESKTOP_PERF=1`.

- Una capsula Obiettivo non compare più e scompare da sola. Due percorsi di pubblicazione
  producevano il lampeggio: il pulse della route ogni 2 s leggeva il record grezzo dell'Obiettivo mentre
  l'archivio dell'input utente di un Obiettivo completato era ancora in scrittura, così la
  capsula ritirata tornava per un frame; e su Windows una lettura dell'Obiettivo
  che cadeva dentro la sostituzione atomica del file (`EPERM`/`EACCES`/`EBUSY`, o la
  scrittura in corso del runtime stesso) emergeva come "nessun Obiettivo" per quel frame. Le
  pubblicazioni della route ora leggono l'Obiettivo attraverso la maschera dell'archivio di continuazione dell'obiettivo,
  e l'archiviazione degli Obiettivi risponde a tali letture dall'ultimo record confermato.

- Browser Use non si ferma più per l'approvazione: la finestra desktop "Consenti una volta"
  che proteggeva `upload` e `clear` condiviso di cookie/localStorage non esiste più, il
  campo `confirm` esce dal contratto dello strumento browser, e la skill browser-use
  elimina le sue regole di via libera in conversazione. `MIXDOG_BROWSER_CONFIRM_ACTIONS`
  e `MIXDOG_BROWSER_DENY_ACTIONS` restano l'unico modo per confermare o rifiutare
  azioni nominate.

- La colonna di lettura del riquadro — composer, trascrizione e dock di Studio — non
  attende più che un riquadro di 1536px si allarghi: da 768px mantiene 800px finché
  il riquadro non supera 1000px, poi segue l'80% del riquadro fino al
  tetto di 1000px a 1250px, così le finestre 1536/1680 e 1920 con un pannello laterale aperto
  smettono di fermarsi a 800px, e un divisore che attraversa il gradino non fa più scattare
  la colonna di 200px.

- Il pannello Sessioni si apre con due righe di avvio fisse, `New task` e
  `New Studio`, fissate sopra l'elenco delle sessioni. Studio quindi lascia la
  barra delle attività: la sua voce di barra solo-avvio e le eccezioni di avvio nel
  layout della vista laterale, nel dock del riquadro e negli interruttori del dock sono ritirate, e un layout
  di barra memorizzato elimina l'id `studio` al caricamento.

- La destinazione Workflow della barra delle attività confluisce nel pannello Progetti: una
  barra degli strumenti `Project | Workflow` — l'interruttore di sezione del pannello Estensioni, ora
  condiviso come un unico componente `SidebarSectionToolbar` — alterna l'elenco
  dei progetti e i pacchetti di workflow, gli agenti predefiniti e le definizioni degli agenti; il
  `+` dell'intestazione segue la scheda Project; `/workflow` e `/websearch` aprono la
  scheda Workflow; e un layout di barra memorizzato elimina al caricamento la vista `workflows` ritirata.

- Il kit della skill pptx guadagna un vocabolario di design nello stile dei sistemi di design
  basati su token: `palette()` ricava tre intensità di linea (`lineSubtle`,
  `line`, `lineStrong`) e quattro colori di stato (`T.state.positive | warning |
  critical | informative`, ciascuno come `solid` / `weak` / `text`, con contrasto
  garantito e mantenuti sotto la banda satura del revisore così una colonna di verdetto
  non fa mai scattare `accent_hue_overuse`); ogni distanza poggia su un'unica scala di spaziatura
  (`SPACE`) nominata per relazione (`GAP.bind` / `within` / `between`, `GUTTER`,
  `PAD`, `M`); ogni ruolo di testo porta un'interlinea fissa; i portatori ripetuti
  (badge, callout, serie di chevron, stat, tabella) leggono la loro anatomia da `SPEC`
  con varianti `tone`, un gradino di scala `stat` e un helper `statBand()`; le icone
  corrispondono a quattro fasce di dimensione; e un nuovo `references/writing.md` fissa le regole di
  frase, registro, numero, data, denaro, unità e margine di traduzione, collegato
  dalle skill docx e xlsx. Ogni portatore di spec firma la propria forma, e la
  ricevuta di composizione rilegge le firme (`slides[].specs`,
  `deck.specs`: conteggio, diapositive, varianti, anatomie) così un portatore la cui dimensione
  del testo o il cui carattere si è discostato tra le diapositive appare come una seconda anatomia.

- I token di design di Office ricavano gli stessi quattro colori di stato (`positive`,
  `warning`, `critical`, `informative`, ciascuno con un campo `Weak` e un gradino
  `Text`, controllati nel contrasto rispetto alla tela, al pannello chiaro e al campo);
  i gate decisionali docx e xlsx disegnano Release e Stop sugli stati positivo e
  critico invece di una tinta letterale e del secondo accento, e il `calloutTone` di una
  sezione `compose_document` mette il suo callout su uno stato.
  L'area di stampa di un dashboard `compose_sheet` ora segue il pannello decisionale,
  così un gate Stop in una colonna oltre la tela non viene più tagliato dalla
  pagina renderizzata ed esportata.

## v0.9.161 - 2026-09-06

- Gli audit di Office misurano Arial, Helvetica, Times New Roman, Courier New,
  Calibri, Cambria e Georgia nei loro caratteri aperti compatibili per metriche
  (Liberation, Arimo/Tinos/Cousine, Carlito, Caladea, Gelasio) ovunque
  l'originale non sia installato, invece di segnalare il carattere come non disponibile
  e approssimare l'adattamento — una macchina Linux con i caratteri Liberation ora
  controlla una presentazione come fa Windows. Il pacchetto radice guadagna le corsie `test:slow` e
  `test:live`, e le corsie runtime della CI installano i caratteri Liberation.

- I commit del Controllo del codice sorgente accettano un riepilogo digitato a mano più una descrizione
  opzionale: preset dei messaggi di commit, controlli di formato, autocompletamento e generazione
  con IA lasciano la scheda Git & GitHub e il modulo di commit, e le preferenze legacy
  `desktop.git` non vengono né lette né scritte.

- Computer Use elimina l'editor di autorizzazione lato impostazioni (blocco di finestra e
  azione, scadenza): resta senza restrizioni per impostazione predefinita con le protezioni
  permanenti — protezioni dell'input, gestione dell'elevazione, presa di controllo dell'utente, protezioni
  dell'ambiente — e un file di autorizzazione salvato non può più scadere in un
  blocco totale. La restrizione in-process sopravvive per un host incorporante tramite
  `MIXDOG_COMPUTER_POLICY_FILE` e `host.updateAuthorization`, nulla viene
  salvato, e l'esportazione della diagnostica degli errori resta. Lo strumento guadagna
  `wait_for_user`: quando l'utente prende il controllo, il modello attende per un intervallo
  limitato e poi cattura lo stato aggiornato invece di indovinare
  i permessi.

- Ogni scheda di Estensioni e Integrati apre la stessa finestra di dettaglio — intestazione con
  identità e titolo, sezioni con la stessa spaziatura, un piè di pagina con una gerarchia di azioni, con quella
  distruttiva a sinistra, un unico stile di pulsante di azione — e le finestre di aggiunta/modifica di Progetti
  la raggiungono. La scheda Git & GitHub porta l'account GitHub
  (accesso gh tramite codice dispositivo); la scheda Local Provider
  elenca i modelli installati con dimensione, contesto e stato di esecuzione, una sezione Caricamento
  modelli per la rimozione dei modelli dalla memoria durante l'inattività, e fatti in tempo reale (build del runtime, GPU,
  memoria libera, server), mentre riparazione e verifica restano guidate dalla chat
  tramite la skill local-provider. I fatti di stato/piattaforma lasciano le finestre
  perché il controllo dell'intestazione e il badge dell'elenco li dicono già. I
  fogli di stile delle estensioni sono divisi in `extension-list.css`,
  `extension-dialog.css`, `extension-editors.css` e `rail-controls.css`.

- Obiettivo: riprendere un Obiettivo in pausa e avviare il suo task approvato sono una sola scrittura
  durevole — `resume` accetta aggiornamenti e aggiunte di task, contrassegnare un task
  `in_progress` riprende l'Obiettivo, e la sola contabilità non concede mai
  l'approvazione. Lo stato di un Obiettivo in pausa raggiunge il modello quando la richiesta
  viene preparata, dopo l'idratazione, invece di un promemoria una tantum sulla risposta dell'utente,
  così nessun turno può perdere il fatto che un Obiettivo è in attesa.

- I telefoni sincronizzano le loro viste alla riconnessione: dopo l'handshake sicuro il
  browser chiede al desktop una baseline coerente delle sue sessioni aperte
  (snapshot, elenco sessioni, pool di agenti, stati delle sessioni) e le pubblicazioni
  live vengono trattenute finché non arriva, così un telefono riconnesso non dipinge più una
  trascrizione obsoleta né perde la coda di un turno. La trascrizione consegnata ai telefoni
  omette il materiale di replay del provider sia nei delta sia nelle baseline.

- La creazione di nuovi task sopravvive a una connessione remota interrotta: ogni richiesta
  porta una ricevuta durevole, così un nuovo tentativo dopo un timeout o una riconnessione approda
  sulla stessa sessione riservata invece di crearne un duplicato, e il watcher dello
  store dei progetti si riprende da solo e riconcilia il catalogo mentre è
  inattivo.

- Conversazioni e barre delle schede si rivelano senza scatti: una trascrizione visitata
  si mostra quando le sue righe visibili e l'offset finale concordano tra i frame (entro
  un secondo, così lo streaming o un font lento non la nascondono mai), e una barra delle schede
  decide l'overflow dal layout di destinazione anziché da una scheda a metà crescita.

- Le azioni del catalogo Local Provider (`searchLocalProviderModels`,
  `inspectHuggingFaceModel`, `registerHuggingFaceModel`) esistono sulla superficie di sessione
  su cui le risolve il daemon, così una chiamata setup instradata attraverso il
  desktop non fallisce più come azione di sessione non disponibile.

- I cataloghi delle lingue dell'interfaccia desktop sono di nuovo allineati con il renderer: le stringhe
  che le viste del controllo del codice sorgente e i comandi slash leggono tramite `t()` mancavano
  da ogni catalogo (la scheda mostrava "History" in coreano), le frasi coreane del
  pacchetto di traduzione legacy ritirato sono migrate in `ko.json` così
  le etichette dinamiche ("Ln 42", "Callers of …") si traducono di nuovo, e le
  stringhe dei menu e delle finestre native sono generate dagli stessi cataloghi. Il coreano è
  completo; le altre dieci lingue ripiegano sull'inglese per le frasi più recenti
  finché non vengono tradotte.

- La build dell'importatore del browser sostituisce un checkout upstream scritto a metà sotto
  TEMP invece di fallire su di esso. Harness di test: le suite del renderer possono importare
  moduli che includono un foglio di stile di funzionalità (un import `.css` si risolve in un
  modulo vuoto sotto Node), il controllo di import del daemon dell'artefatto compilato viene eseguito nella
  corsia live dopo una build, e le fixture dei percorsi dello store delle impostazioni si risolvono nella
  grammatica dei percorsi dell'host stesso.

- La skill e il runtime pdf adottano la disciplina inspect-first delle
  skill PDF di riferimento. Lettura: uno snapshot riporta `encrypted` e
  `passwordRequired` invece dell'errore proprio di pdf-lib, `open`/`snapshot` con
  `password` leggono il testo di un file bloccato per quella chiamata senza conservare la
  password, ogni modifica su un file cifrato rimanda a `secure` → decrypt,
  le pagine portano dimensione e rotazione, i segnalibri tornano sotto `outline`
  con la pagina che ciascuno apre, e l'estrazione del testo (snapshot office, allegati
  della chat, strumento read) mantiene le fini di riga come a capo così paragrafi e
  righe di tabella sopravvivono. Moduli: i campi espongono il tipo
  `text|checkbox|radio|dropdown|optionlist`, `options`, `readOnly` e
  `multiline` di cui un fill ha bisogno; `fill_form` nomina un campo o un'opzione sconosciuti
  insieme a ciò che esiste e riporta `filled`; `add_form_field` e
  `create` accettano `optionlist`, `required`, `readOnly`, `maxLength` e
  `fontSize`; il lint segnala una casella troppo piccola per essere usata (`formIssues` su create,
  `field_too_small` in `issues`); `preview_fields` scrive una copia con ogni
  campo e qualsiasi casella proposta delineati e nominati così un render mostra il posizionamento
  prima di un fill; un menu a discesa o un elenco con opzioni coreane non
  fallisce più alla creazione perché il widget è dipinto con il carattere
  incorporato fin dall'inizio; e un campo multilinea ha come predefinito 11 pt invece della
  dimensione automatica di pdf-lib, che disegnava la prima riga enorme e scartava il resto.
  Caratteri: `create`, `add_text`, `watermark`, `fill_form` e OCR incorporano
  da soli un carattere Unicode installato quando il testo è coreano, CJK,
  cirillico o greco (`pdf-fonts.mjs`; `fontPath` sceglie ancora; `detect`
  nomina il carattere come `portable.pdfUnicodeFont`). Scrittura: `create` manda a capo
  la prosa senza spazi per carattere, rispetta `\n`, manda a capo le celle di tabella e fa crescere le
  righe, ripete l'intestazione dopo un'interruzione di pagina, numera l'output multipagina,
  e accetta `columnWidths`, `level` dei titoli, `align` delle immagini, `orientation`,
  `footer` e più formati di pagina. Modifica: `merge_pdf` accetta `sources:[path | { path,
  pages, title }]`, `index` e `bookmarks:true`; `add_bookmark` scrive una
  voce di outline; `extract_pages` scrive in `output` e `split_pages` un file
  numerato per pagina o ogni `every` pagine senza toccare il documento
  di sessione; `extract_attachment` fa il round-trip dei file incorporati; `rotate_pages`
  si somma alla rotazione corrente; `delete_pages` mantiene una pagina; `compress`
  riporta `bytesBefore`/`bytesAfter`; `add_text` accetta `align:'center'|'right'`
  e numera un file esistente tramite `{page}`/`{pages}`; `highlight` segna
  ogni corrispondenza di `find` (o una casella; `wholeWord`, `regex` e `first` la
  restringono) con un segno a fusione multiply che lascia il testo leggibile; `add_link`
  posa un link invisibile su una corrispondenza che apre un URL o un'altra pagina, oppure
  con `urls:true` fa sì che ogni indirizzo http(s) nel testo si apra da sé;
  `stamp_image` si adatta entro i margini a meno che non sia dimensionato;
  `issues` non riporta più due volte una pagina scansionata e nomina il contenuto attivo
  (`active_content`: JavaScript, Launch, azioni all'apertura, link a file o
  ad altri schemi non web) senza seguirlo. Analisi: `pdf-layout` con
  `query` restituisce solo le corrispondenze con le loro caselle; le sue caselle di testo seguono
  il tratto sulle pagine ruotate e per il testo diagonale, ed esso e lo snapshot riportano
  `origin` quando una casella di pagina non parte da 0,0. I segni di `find` invertono la
  trasformazione di visualizzazione per gestire sia gli offset di origine sia le rotazioni di pagina
  di 90/180/270 gradi senza riorientare il documento; `first:true` preserva l'ordine
  delle righe del documento a ogni rotazione. Il layout elenca i
  link di ogni pagina (`url` o la `page` di destinazione) e aggiunge le linee (`lines`) di ogni pagina e
  `boxes` (piccoli quadrati contrassegnati `checkbox`), che è ciò di cui ha bisogno la compilazione di un modulo
  senza campi; `pdf-tables` legge una tabella con bordi dai suoi
  rettangoli di cella (`source:'ruled'`, celle a capo intatte) prima dell'ipotesi
  di allineamento del testo (`source:'alignment'`) e scrive un CSV per tabella
  quando viene dato `output:<dir>`, come `pdf-images` scrive file PNG e riporta
  dove si trova ogni immagine nella pagina; OCR adatta
  ogni parola invisibile alla sua casella così il livello di testo mantiene spazi singoli. Le anteprime
  di pagina (`render`, `qa`, `finalize`) danno a pdf.js i suoi caratteri
  standard inclusi, così una pagina impostata in Helvetica o Times non viene più resa
  con spaziatura tra le lettere. L'adattatore è diviso in `pdf-writer`, `pdf-forms`,
  `pdf-draw` e `pdf-fonts`, e la skill è riscritta come inspect →
  create → edit → secure → verify con il requisito qpdf (PATH o
  `MIXDOG_QPDF_PATH`), l'avvertenza sui bit di permesso e il limite del testo in-place
  dichiarati.

- La skill e il runtime xlsx adottano la disciplina di modellazione che un lettore si aspetta
  da un foglio di calcolo: un audit delle formule indipendente dal backend (condiviso da `issues` portabile
  e dalla revisione di qualità) segnala un riferimento di foglio multi-parola senza virgolette, un collegamento
  a cartella di lavoro esterna, una percentuale memorizzata come numero intero,
  un anno con separatore delle migliaia e una cifra memorizzata come testo
  per ogni cartella di lavoro (più, come informazione, un foglio lungo la cui intestazione
  non è bloccata e una colonna di tabella di numeri in formato Generale), e
  con `auditProfile:'financial-model'` un tasso inline in una formula, una divisione
  non protetta, una formula isolata che rompe lo schema della sua riga o colonna,
  un singolo riferimento oltre l'estensione popolata del foglio (l'errore di uno
  che si ricalcola senza problemi), un valore fisso dentro una riga di formule, e input
  indistinguibili dalle
  formule, più un input letto da una formula che non porta alcuna nota sulla fonte e una
  quadratura del foglio Checks che risulta FALSE — su entrambi i backend, poiché `issues` di Excel
  ora integra l'audit condiviso nei riscontri propri dell'host. Gli snapshot
  espongono formato numerico, carattere, colore e riempimento di ogni cella con stile (gli interi BGR di Excel
  si normalizzano nella stessa forma RRGGBB), le note legacy per cella e per
  foglio, le tabelle Excel per foglio (i record al loro interno sono dati che la tabella
  alimenta, così l'audit chiede una nota solo sulle ipotesi esterne ad essa),
  intervalli uniti e riquadri bloccati nella forma di Excel,
  i booleani come booleani, il `defaultStyle` della cartella di lavoro, e un riepilogo
  `document.conventions` (carattere predefinito, caratteri in uso, formati numerici
  per colonna, marcatori degli input, input di esempio) così una modifica può adeguarsi alle
  convenzioni del file stesso; `set_formula` mette tra virgolette i nomi di foglio multi-parola che la
  cartella di lavoro contiene (e, su entrambi i backend, qualsiasi nome multi-parola scritto
  prima di `!` e di un riferimento) e riporta la `normalizedFormula`, il ricalcolo di
  LibreOffice restituisce uno `status` con `totalErrors`, un `errorSummary` per
  tipo di errore e cella, e le `unparsedFormulas` che LibreOffice ha riscritto in
  minuscolo, e `finalize` rifiuta una cartella di lavoro il cui ricalcolo ha trovato un qualsiasi
  errore anche quando la revisione è stata saltata. La skill riscrive le sue regole attorno a zero
  errori nelle formule, formule al posto di risultati incollati, specifiche letterali, ipotesi
  documentate, la legenda di compilazione e l'adeguamento alle convenzioni di un file esistente,
  con `references/model-conventions.md` per colori, formati numerici,
  struttura, il foglio Checks e le fonti.

- La skill pptx si apre con una tabella di instradamento — un nuovo set di diapositive è uno script
  `author`, un set esistente è `open` → `snapshot` → `batch`, e la lettura è
  uno `snapshot` paginato o l'estrattore di sorgenti — e risolve i percorsi dei suoi script
  tramite `${MIXDOG_SKILL_DIR}`, così il QC delle pagine, il revisore indipendente e
  `source-extract.mjs` (spostato nella skill con un test) funzionano da qualsiasi
  Progetto. La sezione di modifica nomina le insidie che il runtime ha davvero:
  una diapositiva duplicata condivide la sua parte grafico con la sorgente, la
  decorazione del template resta dove l'ha messa il numero di righe del segnaposto, e uno script
  che dichiara il proprio `pres` eredita la tela 10 × 5.625 in di pptxgenjs.
  Le skill docx, xlsx e pdf aggiungono i trigger che gli utenti scrivono davvero
  ("Word", "Excel", "PDF 읽어", "PDF 만들어"), e la skill docx dice come uno
  snapshot mostra un'interruzione di riga.

- La modifica portabile di PowerPoint risolve il target della relazione di un grafico come fa
  il pacchetto: pptxgenjs lo scrive come nome di parte assoluto
  (`/ppt/charts/chart1.xml`), che `set_chart_data` e le altre operazioni sui grafici
  di una presentazione creata riportavano come parte mancante.
  Gli snapshot portabili ora mantengono le interruzioni di riga e le fini di paragrafo come a capo — il testo di forme
  e note di una presentazione, e il testo di paragrafi, celle, commenti,
  revisioni, note e controlli di contenuto di un documento Word — invece di unire "4주차" e
  "잔존율".

- Le barre delle schede dei riquadri animano aggiunte e chiusure con la temporizzazione delle animazioni dell'interfaccia: una nuova scheda cresce
  dal nulla mentre le vicine si restringono, così la serie non va mai in overflow
  della barra e poi torna indietro, e una scheda chiusa collassa sul posto mentre le
  superstiti scivolano nel suo spazio invece di saltare. Una bozza promossa a
  sessione si scambia ancora istantaneamente, e la barra elimina il suo stato inutilizzato di
  mantenimento della larghezza.

- La creazione in Office guadagna tre strutture per la qualità dell'output: `author` e
  `batch` restituiscono un `audit` misurato (adattamento, limiti, contrasto, spaziatura, pacchetto)
  con conteggi per diapositiva e un mandato di correzione nello stesso turno che conta i suoi round;
  `author` rifiuta di consegnare una presentazione le cui cifre non hanno alcun fatto alle spalle
  (`facts_gate`) a meno che il brief non dichiari `facts: sample`, che porta
  un'informativa sulle cifre illustrative attraverso qa e finalize; e la skill pptx
  include `scripts/qc-pages.mjs`, un correttore per pagina che esegue una sessione nuova
  per diapositiva con il solo strumento office e adotta la sua copia di lavoro solo quando
  i difetti misurati della pagina non sono cresciuti e nessun'altra diapositiva è cambiata.

- Le skill dividono la riga dell'elenco in una descrizione di una frase e un
  trigger `when_to_use`; l'elenco delle skill del modello mostra `description — trigger`
  tagliato a 250 caratteri, l'editor delle skill guadagna un campo Trigger separato, il
  validatore di skill-creator avvisa quando una riga dell'elenco verrà tagliata, e ogni
  skill integrata è riscritta nella nuova forma.

- L'isola Obiettivo della sessione allinea il suo elenco di task con l'intestazione compressa,
  separa le righe con linee sottili, e si comprime al clic esterno o con Esc.

- La superficie per telefono segue il chrome del desktop: l'indicatore del contesto sta accanto
  al selettore del modello del composer, i segni della barra degli strumenti condividono la famiglia lucide,
  e il foglio destro si apre come un'unica unità dock la cui intestazione porta gli stessi
  interruttori di vista della barra del desktop.

- Le skill integrate vengono distribuite da una sorgente di skill inclusa, e le guide Office
  diventano le skill pptx, docx, xlsx e pdf condizionate dalla funzionalità che guidano.
  Le impostazioni raggruppano skill, server MCP e hook dipendenti sotto il loro plugin
  o la loro funzionalità integrata.

- Office crea presentazioni PPTX da script pptxgenjs con una guida al design,
  kit di helper, menu dei layout e QA visivo guidato dal modello, e tollera
  le differenze nell'ordine dei figli di presentazione e grafico.

- Le chiamate degli strumenti forzano gli argomenti in testo JSON alla forma di schema dichiarata,
  compresi gli schemi interni del registro.

- Browser Use divide URL, schede, partizione, oscuramento dei dati e criteri degli script di snapshot
  in moduli dedicati; Computer Use rifinisce il modello dell'overlay, il backend
  di input e il coordinamento delle sessioni.

- Il warmup di avvio del desktop, il ripristino del dock laterale, i tempi di azzeramento dell'utilizzo, i file di
  discovery di proprietà del bridge e il recupero del trasporto delle sessioni mantengono reattivi gli avvii a freddo e
  le riconnessioni. I deploy FastDirect precaricano il runtime installato.

- Il test runner separa i livelli fast, slow e live con report dei tempi;
  gli store delle sessioni mettono in cache i riepiloghi delle trascrizioni e le scansioni degli elenchi;
  le utilità di richiesta dei provider rafforzano la gestione del wire di Anthropic, Cursor e OpenCode.

## v0.9.160 - 2026-09-02

- La TUI ora installa il suo runtime Ink patchato da un asset di rilascio versionato.
  Le build di produzione, gli harness dei frame e le sonde di carico risolvono il pacchetto
  installato preservando il comportamento personalizzato di cursore, selezione e rendering.

- L'avvio del desktop ora rivela shell di riquadri utilizzabili prima che l'idratazione più lenta di catalogo e
  runtime sia completata. Le superfici Browser, Terminale, Editor e dock laterale
  si ripristinano in modo indipendente, con sonde di prontezza mirate e servizi host
  differiti che mantengono reattivi gli avvii a freddo.

- Browser Use e Computer Use ora hanno moduli host basati sui ruoli anziché
  monoliti piatti. Le azioni del browser condividono instradamento esplicito, ciclo di vita del guest e
  contratti di risposta con una gestione più solida di selettori di file e finestre di dialogo, mentre
  Computer Use separa le responsabilità di discovery, osservazione, input, sessione, overlay e
  backend con una copertura di sicurezza ampliata.

- I moduli runtime di Office sono organizzati per ruoli core, design, qualità, portabile,
  PDF, COM e benchmark. Composizione libera, selezione del layout guidata da riferimenti,
  scene PowerPoint create e controlli di garanzia renderizzati migliorano la
  qualità visiva senza indebolire l'output modificabile né i confini delle transazioni.

- Le sessioni Anthropic OAuth ora apprendono una versione minima della CLI richiesta dal provider,
  persistono solo aggiornamenti sicuri verso l'alto e ritentano una volta la richiesta rifiutata senza
  sovrascrivere la configurazione esplicita della versione.

## v0.9.159 - 2026-09-01

- L'accettazione del rilascio su Windows ora controlla l'inventario canonico di 16 voci delle
  impostazioni invece del vecchio conteggio precedente alla navigazione.

- Computer Use ora coordina i lease del target in primo piano, ricattura dopo le
  transizioni di finestra, convalida sequenze di azioni limitate ed espone un overlay di
  presa di controllo dell'utente. I percorsi di cattura, tastiera, targeting e recupero sono
  divisi in moduli mirati con una copertura più ampia di host e bridge.

- Browser Use guadagna registri con ambito di sessione e superfici persistenti per conversazione.
  Le viste browser, diff e utilità possono restare collegate al dock laterale di ciascuna
  conversazione, mentre le letture di file locali sostituiscono il ritirato percorso duplicato
  dell'explorer delle cartelle.

- La compattazione a contesto nuovo ora porta un passaggio di consegne limitato della Memoria, preserva
  la continuazione del turno attivo e lo stato dell'envelope degli strumenti, e mantiene stabili i layout
  della cache del provider attraverso la compattazione. L'ingestione della Memoria proietta la trascrizione
  compattata in modo coerente invece di affidarsi al ritirato percorso fast-track.

- La generazione di presentazioni Office aggiunge direzione creativa, grammatica dei layout, flusso
  visivo semantico, revisione estetica renderizzata e un punteggio di qualità di rilascio così
  l'output delle presentazioni è più vario e coglie prima le composizioni deboli.

- Il tumulto di verifica e infrastruttura di rilascio cala nettamente: il monolite
  tool-smoke di 3,500 righe è ora quattordici suite `node --test` mirate sotto
  `scripts/tool-contracts/` con asserzioni fragili sulla formulazione esatta allentate a
  contratti di frasi chiave, la selezione dei percorsi della CI ha un'unica fonte in
  `scripts/release-paths.mjs` sia per il gate di rilascio sia per la pianificazione del deploy,
  e un rilascio salta la riesecuzione della corsia critica quando il gate ha già
  verificato esattamente gli stessi commit.

- Nessuna suite può più marcire in silenzio: i restanti monoliti di test
  (provider-toolcall, session-transport, shell-hardening) sono suite per dominio
  sotto `scripts/`, il gate di rilascio ora esegue i contratti degli strumenti
  e di compattazione (recall-fasttrack) a ogni push controllato, e una
  scansione settimanale `suite-health` esegue ogni script `test:*`/`smoke:*`
  registrato tramite un catalogo opt-out che apre un'issue tracciata in caso di errore.

## v0.9.158 - 2026-08-31

- L'hub Estensioni ora offre a Git, Memoria, Browser Use, Computer Use, Office
  e voce un flusso coerente di installazione, avanzamento, attivazione e disattivazione. I runtime
  opzionali vengono preparati su richiesta, Office può installare LibreOffice tramite il
  gestore di pacchetti della piattaforma, e disattivare la voce preserva gli asset scaricati.
- Il packaging del runtime desktop è più piccolo e deterministico: i payload delle funzionalità opzionali
  restano fuori dall'app di base, il codice runtime è preparato una sola volta, i deploy snapshot
  tollerano modifiche concorrenti, e la CI di rilascio condivide un'unica build
  runtime multipiattaforma con gate espliciti per Git e Computer Use.
- Studio preserva le bozze per elemento e rende resilienti alla navigazione la modifica
  del dettaglio, la selezione e le interazioni da tastiera. I controlli di utilizzo del contesto e
  dettatura vocale riportano inoltre il loro stato attuale in modo più coerente.
- La route OpenAI OAuth lascia per impostazione predefinita disattivato il prewarming del prompt WebSocket,
  evitando una richiesta di warmup non necessaria a meno che non sia esplicitamente abilitato.
- Terminal-Bench 2.1 pubblica il confronto completo `k=5` della Codex CLI con gli artefatti
  Harbor grezzi, verifica del commit sorgente, provenienza dei costi recuperati e
  generazione riproducibile dei report.

## v0.9.157 - 2026-08-31

- Browser Use guadagna una suddivisione host più piccola e affidabile tra schede, download,
  intercettazione, permessi, snapshot, segnalazione delle finestre di dialogo e ciclo di vita delle pagine.
  L'importazione del profilo Chromium ora include la decifrazione offline dei cookie App-Bound v20
  tramite l'importatore nativo incluso nel pacchetto senza esporre i segreti decifrati al
  renderer o all'agente.
- Computer Use è scomposto in moduli limitati di cattura, discovery, targeting,
  osservazione, input e worker. Una proprietà delle risorse più equa, uno stato post-azione
  più fresco, protezioni dell'input più rigorose e scenari di ripetizione ampliati rendono più veloci e sicure
  le sessioni native e Chromium di lunga durata.
- La Memoria passa a un runtime di embedding E5 compatto con backfill incrementale
  dal più recente, compressione e conservazione della cache, ranking lessicale consapevole del coreano e
  recupero dei worker inattivi. Il vecchio addon nativo dei token e il percorso più pesante del modello
  legacy sono rimossi dal runtime distribuito.
- Il recupero delle sessioni promuove il journal dei checkpoint a confine di ripresa
  durevole, preservando l'utilizzo del provider, gli ancoraggi di compattazione, il passaggio di consegne del recall e
  il replay del thinking di Anthropic attraverso interruzione, nuovo tentativo e riavvio senza
  duplicare il contesto.
- La creazione in Office aggiunge piani di composizione scritti dal modello, una libreria di design
  riutilizzabile, anteprima dei documenti e primitive portabili più ampie per Word, Excel e PowerPoint
  mantenendo i controlli di garanzia strutturali e renderizzati.
- Le superfici web desktop e mobile guadagnano Browser Use remoto, ricezione tramite share-target,
  notifiche push, modifica e anteprima di documenti più ricche, ripristino all'avvio più silenzioso
  e aggiornamenti della cache del service worker più prevedibili.
- La ricerca nativa ora limita i lease di inventario ampi e ammette in modo equo i lavori concorrenti di
  find, glob e grep. L'automazione del rilascio ricostruisce incrementalmente gli asset nativi
  e vocali modificati, verifica i sidecar pacchettizzati e riusa gli artefatti runtime
  di piattaforma invariati.

## v0.9.156 - 2026-08-29

- La creazione portabile in Office guadagna il rendering dei grafici e le metriche del testo, così più
  lavoro PPTX e XLSX si completa senza passare all'host Office COM.
- I contratti degli strumenti Browser Use e Computer Use sono rivisti insieme
  allo store delle impostazioni desktop, alla convalida IPC e alla formattazione degli strumenti nella trascrizione.
- Lo scorrimento virtuale del desktop ora segue i pacchetti upstream, e l'ancoraggio in basso
  della trascrizione si affida al differimento di scorrimento del core stesso.
- I deploy di sviluppo possono partire da uno snapshot congelato dell'albero di lavoro
  (`update:dev:snapshot`), il che permette a un'installazione di riuscire mentre altre sessioni
  continuano a modificare il repository invece di fallire il controllo dell'impronta degli input.

## v0.9.155 - 2026-08-29

- L'importazione di diapositive PPTX, la sostituzione di immagini e la creazione di dati di tabella ora vengono eseguite nel
  motore portabile, quindi quelle operazioni non richiedono più l'host Office COM.
- La creazione in Office guadagna moduli portabili di packaging, composizione, stile dei fogli e
  forme delle diapositive dietro la pipeline esistente di garanzia e qualità.
- Il tracciamento degli Obiettivi guadagna promemoria e gestione dell'estrazione del testo per le continuazioni,
  e il desktop mantiene sincronizzati i metadati di sessione con un budget di cache del renderer limitato
  per lo stato delle sessioni non lette.

## v0.9.154 - 2026-08-29

- Le sessioni Computer Use vengono recuperate su ogni percorso di uscita invece di dipendere da
  un timer unref'd che un runtime in uscita non fa mai scattare: l'arresto del daemon e dei worker
  le rilascia, una sessione in chiusura rilascia la propria, i worker host inattivi scadono sullo
  stesso clock dei claim di finestra che detengono, e una connessione client interrotta
  annulla l'input in corso anziché lasciarlo pilotare il desktop fino al
  timeout del comando. Il client riprova inoltre una volta contro un bridge ripubblicato, così
  il riavvio dell'app desktop non fa più fallire subito il comando successivo.
- Una pagina Browser Use andata in crash si ripristina al comando successivo invece di farlo fallire.
  I ref legati al documento morto vengono scartati con esso, così il recupero non può mai
  restituire coordinate di una pagina che non esiste più.
- La compattazione che gira tra un prompt e la richiesta al provider non si blocca più
  quando il runtime della memoria si ferma: la chiamata alla memoria recall-fasttrack è limitata per
  ogni chiamante, non solo per il percorso che si era trovato a cablare un timeout.
- Il parser delle voci nascoste di Windows Explorer divide l'output di attrib.exe con le regole
  dei percorsi Windows su qualsiasi host, e la sonda delle capacità dell'hook di commit ora funziona con
  le versioni di git che non concordano sul fatto che un nome di hook non nativo richieda un flag.
- Deploy smette di ricostruire runtime di piattaforma identici byte per byte. I sorgenti dei test escono
  sia dal pacchetto pubblicato sia dalla chiave della cache del runtime, così una modifica solo ai test
  colpisce la cache del runtime preparato invece di pagare una ricostruzione Windows di sette minuti. Le suite desktop vengono eseguite come job di gate paralleli, compresa una tappa Windows che
  finalmente esercita Computer Use nella CI, e la suite git da 240 secondi non
  fa più parte dell'esecuzione locale predefinita.

## v0.9.153 - 2026-08-28

- Computer Use su Windows ora esegue un ciclo di osservazione più ridotto in stile CUA: per impostazione predefinita
  vengono restituiti insieme un'accessibilità compatta e uno screenshot semplice,
  lo stato post-azione viene aggiornato subito, AX e OCR di fallback condividono un unico
  budget rigoroso di elementi, le acquisizioni inutilizzabili nere, bianche o non corrispondenti non
  emettono mai un frame di coordinate, le mutazioni invalidano i frame di pixel precedenti, un nuovo
  popup dello stesso processo diventa il target deterministico di verifica, i campi di testo
  Electron dell'app usano l'inserimento in background nativo del renderer, il recupero nomina
  un solo gradino successivo di escalation, e i tasti pericolosi che terminano la sessione, i payload shell
  o gli avvii di shell/script host sono bloccati al confine dell'host. Un dashboard Windows con 23 scenari ora copre
  percorsi nativi, Electron, Chrome, OCR coreano, secondo display, stato obsoleto, focus,
  popup, sicurezza e pulizia.
- Le osservazioni e i turni di Computer Use sono più veloci senza indebolire il confine
  dell'input: snapshot Win32 leggeri di transizione/frame, cattura della finestra esatta,
  accessibilità Chromium moderna limitata, polling di avvio adattivo, protezioni delle risorse
  di cattura e recupero verificato di focus/cursore sostituiscono la ripetuta enumerazione completa delle app
  e i fallback illimitati. La digitazione letterale su un elemento di destinazione può
  mettere a fuoco e digitare in una sola azione, e un OCR limitato può essere incluso nella
  cattura post-azione obbligatoria. La matrice finale 23 scenari × 10 sorgenti-host ha raggiunto
  230/230 successi semantici e ridotto la latenza p50/p95 di base degli scenari del
  90.55%/94.01%; una matrice di stress separata denso/minimizzato/target obsoleto ha superato
  40/40. Tutte le 30 ricatture post-azione ridondanti sono state rimosse, e le chiamate sono calate del
  36.84% nei cinque workflow di azioni raggruppabili. Il batching arbitrario di mutazioni
  resta non supportato.
- Computer Use ora espone un unico contratto rigoroso di 15 azioni invece di 28
  azioni sovrapposte o di uno schema piatto di campi opzionali. Osservazione/ricerca/zoom
  usano `capture`, il ciclo di vita di finestre e appunti usa campi di operazione, e un unico
  oggetto condiviso `capture_after` configura la verifica automatica. Una guida
  allineata ai riferimenti richiede target esatti e aggiornati, preferisce gli elementi semantici
  e mantiene Browser Use separato. Lo schema finale era di 2,644 token stimati
  prima delle estensioni di frontiera; il contratto di frontiera prima della rimozione ha superato
  36/36 scenari modello alla prima chiamata. L'attuale contratto a dispatch diretto è
  di 3,210 token stimati e 14,485 byte sul wire. Il `diagnose` di sola lettura
  riporta la prontezza di OCR/UIA di Windows senza pixel dello schermo; il `sequence` limitato
  si ferma su errore o transizione di target e restituisce un unico stato finale aggiornato;
  la rigorosa cardinalità delle chiamate impedisce mutazioni parallele su target diversi sia
  nella guida al modello sia prima del dispatch eager del runtime. Le chiamate `computer` extra
  nello stesso turno non vengono eseguite e ricevono un errore di recupero con stato aggiornato.
  La selezione in linguaggio naturale ha superato 4/4 catene di focus sicure e 4/4 confini
  di transizione. In 10 ripetizioni, una continuazione di due azioni ha usato il 50% in meno di
  chiamate e catture rivolte al modello, con la latenza p50/p95 in calo del 12.34%/32.31%.
  Le richieste di conferma di Computer Use rivolte al modello e di approvazione delle transazioni Office
  sono state rimosse; le azioni richieste dall'utente ora vengono eseguite direttamente mentre
  i pattern di tasti, payload e script host bloccati restano errori rigidi.
  L'utilizzo misurato del provider è di 5,150 token di input e 4,026 ms p50 per chiamata
  del modello. Uno schema post-osservazione di 12 azioni ha ridotto l'input del 18.16% con accuratezza
  27/27 ma è stato rifiutato perché ripetuti outlier di latenza e cambi di
  schema a metà ciclo violerebbero il contratto immutabile della cache del prefisso del provider.
  Le azioni semantiche con transizioni deterministiche della finestra esatta ora riportano
  una verifica confermata. Non resta alcun fallback con la vecchia forma di chiamata. Dopo un
  deploy di sviluppo, la convalida dell'app installata ha confermato che il `click(ref)` sinistro
  usa l'attivazione semantica e che un avvio per associazione di file nativa
  restituisce il suo target selezionato con stato aggiornato; marcatori e coordinate
  restano operazioni esplicite del puntatore.
- Browser Use può importare password, cookie e cronologia di Chromium, suggerire solo
  account mascherati per l'origine HTTPS corrente e compilare un modulo di accesso selezionato
  all'interno di un mondo CDP isolato senza esporre la password memorizzata al
  renderer, all'agente, alla diagnostica o ai log. Utilities ora usa come predefinita la prima
  scheda sul lato destro, migra la vecchia collocazione predefinita senza reimpostare i layout
  personalizzati, e include il punto di ingresso Browser.
- FastDirect ora calcola l'impronta, prepara, esegue il backup e ripristina atomicamente gli
  sidecar nativi dell'importazione del browser insieme a `runtime.asar`, così gli aggiornamenti
  incrementali di sviluppo non possono lasciare l'app installata senza il suo importatore.
- L'utilizzo del contesto della sessione ora registra uno snapshot canonico post-compattazione che
  sopravvive alla persistenza e al riavvio finché il turno successivo non lo invalida. Lo stato dell'Obiettivo
  e il recupero della compattazione restano coerenti tra servizi riavviati
  invece di ridipingere un utilizzo di token obsoleto o perdere lavoro riprendibile.
- La generazione di Office ora condivide un modello di contenuto semantico, controlli di garanzia
  strutturali e renderizzati, revisione contro la prompt injection, gate a checklist e una
  pipeline di rifinitura per Word, Excel e PowerPoint. I controlli di pagina/vista dei fogli di calcolo, la selezione
  della capacità dei template, la persistenza nativa dei dati dei grafici e la verifica
  live di salvataggio e riapertura rafforzano i documenti di qualità da rilascio.

## v0.9.152 - 2026-08-27

- La modalità Obiettivo può ora portare un obiettivo di lunga durata attraverso più turni con condizioni di
  completamento durevoli, controlli di pausa e ripresa, limiti di tempo, continuazione
  automatica, strumenti di gestione rivolti al modello e un'isola di stato Desktop
  con ambito di sessione.
- Browser Use e Computer Use per Windows sono disponibili come funzionalità integrate
  opzionali. Browser Use può ispezionare e operare su pagine in-app o in background,
  mentre Computer Use combina UI Automation, screenshot, tastiera, puntatore,
  scorrimento e azioni sulle finestre con input consapevole del DPI e protezioni di sicurezza.
- Il recupero del provider ora preserva l'ordine originale di ragionamento, testo e
  chiamate di strumenti attraverso gli stream Anthropic, Gemini, OpenAI e compatibili, compresi
  nuovi tentativi, turni bloccati, sessioni salvate, proiezione remota e compattazione.
- La compattazione avvia una nuova epoca della cache di lettura dopo aver modificato la trascrizione,
  e le sessioni esistenti sincronizzano gli strumenti runtime appena disponibili ai confini
  dei turni invece di mantenere un catalogo di strumenti obsoleto.
- La navigazione desktop e mobile è più pulita e prevedibile: i riavvii mobile
  partono da un solo Nuovo task mentre le riconnessioni mantengono i riquadri correnti,
  gli swipe dei riquadri funzionano su contenuti ricchi e overlay, e pagine laterali, estensioni,
  Markdown, etichette di stato e azioni finali condividono layout responsive più compatti.

## v0.9.151 - 2026-08-26

- Modificare un collegamento simbolico ora cambia il file a cui punta invece di essere
  rifiutato: patch ed edit seguono il collegamento in ogni motore, scrivono
  atomicamente accanto al vero target e lasciano intatto il collegamento stesso.
- Le esecuzioni headless e di benchmark non lasciano più database e processi temporanei
  in giro. Ogni esecuzione ottiene una radice runtime isolata, l'arresto attende il daemon
  di sessione invece di riportare il successo prima di esso, e i cluster orfani vengono
  eliminati all'uscita.
- La compattazione della conversazione mantiene tutto ciò che deve. La compattazione automatica, manuale e
  azzerata condividono un unico percorso, il riepilogo memorizzato apre con l'intera cronologia grezza
  alle spalle, e i turni più recenti sopravvivono letteralmente invece di essere
  tagliati da un limite di righe o dimensione.
- L'esplorazione legge il file originale prima di decidere come analizzarlo, contarlo o
  riassumerlo, così un'ipotesi sul formato non guida più la risposta.
- Rifiniture desktop: le immagini allegate si aprono nel visualizzatore di sistema, le righe di quota del
  pannello di utilizzo si leggono in un ordine naturale, e i pannelli di contesto e route
  perdono i loro bordi residui e i contorni di focus.
- I risultati di Terminal-Bench 2.1 sono ripubblicati da un'esecuzione `k=5` di tutti gli 89 task,
  con gli artefatti grezzi di verifica di ogni esecuzione pubblicata inclusi nel repository
  insieme all'harness e agli script delle metriche.

## v0.9.150 - 2026-08-25

- I risultati degli strumenti restano scorrevoli e onesti sulla dimensione: l'output delle ricerche e
  le letture multi-file restano entro un budget fisso invece di inondare una risposta di
  migliaia di righe, e un percorso che semplicemente non esiste — o un normale verdetto
  sullo stato del repository — torna come risposta anziché come errore
  che manda l'assistente in recupero.
- Le sessioni non portano più un'impronta del provider obsoleta attraverso un riavvio, e un
  nuovo messaggio risveglia subito un turno in attesa di un task in background, così
  una risposta arriva invece di restare dietro l'attesa.
- La selezione del testo del terminale si riprende da un trascinamento il cui pulsante è stato rilasciato
  fuori dalla finestra, e una selezione trascinata oltre il bordo superiore o inferiore
  segue il normale comportamento di inizio e fine riga invece di bloccarsi all'ultima
  colonna tenuta dal puntatore.
- La dettatura vocale chiede conferma prima di installare il proprio runtime, le schede
  degli strumenti e i frame dei diff si allineano sul tema condiviso, e dieci lingue
  dell'interfaccia sono aggiornate.

## v0.9.149 - 2026-08-24

- Le sessioni OpenAI OAuth ora parlano per impostazione predefinita la forma wire del client di riferimento:
  identità stabile di installazione e thread, la forma di richiesta più leggera sui modelli
  attuali, e gestione corretta per il provider di un socket che raggiunge il limite di durata
  a metà sessione.
- L'avvio della sessione riserva la sua connessione pre-riscaldata al primo turno solo
  quando il prompt che ha riscaldato corrisponde ancora, così un turno il cui ambiente o la cui
  superficie di strumenti è cambiato parte da zero invece di rinviare l'intera richiesta.
- Gli elenchi di directory restituiscono una prima pagina dimensionata per la scansione anziché un dump,
  e le ricerche sulla struttura del codice recuperano i corpi completi dei simboli solo quando serve l'
  implementazione esatta.

## v0.9.148 - 2026-08-24

- Le conversazioni desktop e mobile preservano bozze, cronologia, comportamento di follow,
  gesti dei riquadri e stato remoto in modo più affidabile, riducendo il trasferimento del relay
  e l'overhead di deploy del renderer.
- Le sessioni degli agenti recuperano stream del provider, compattazione, stato dei worker e risultati
  degli strumenti in modo più coerente, con esiti più chiari di conflitti Git e ambiente
  e telemetria di ricerca più accurata.
- L'input vocale guadagna un percorso di rilascio del runtime multipiattaforma verificato, mentre
  il recupero dalla memoria, la gestione dei processi nativi e la preparazione del runtime pacchettizzato
  sono rafforzati.
- L'automazione dei rilasci, il deploy FastDirect e i report dei benchmark ora riusano gli
  artefatti invariati e confrontano chiamate al modello, costo e contesto finale con
  una contabilità corretta per provider.

## v0.9.147 - 2026-08-21

- Le lunghe sessioni OpenAI ora mantengono intatti la catena di risposte e il pin dello stato del turno
  attraverso riconnessioni, riordinamento degli elementi e compattazione, così la cache del
  prefisso del provider sopravvive a una sessione invece di ripartire a metà task.
- L'avvio della sessione pre-riscalda il prefisso del provider e separa i dettagli dell'ambiente
  dal prefisso condiviso delle istruzioni, riducendo gli avvii a freddo e il caricamento ripetuto
  di contesto identico.
- Le regole d'uso degli strumenti si leggono più brevi con le stesse garanzie: le clausole di instradamento ora
  scompaiono insieme agli strumenti che nominano, e i risultati della shell sono classificati dal
  runner che li ha prodotti.
- Le schede degli strumenti desktop e i riepiloghi dei risultati sono localizzati, e l'indicatore del contesto
  riporta la stima post-compattazione invece del prefisso scartato.
- Le esecuzioni dei benchmark guadagnano preset di route veloci e un adattatore di riferimento grok CLI, così
  i numeri di riferimento provengono dagli stessi container e dallo stesso verificatore.

## v0.9.146 - 2026-08-21

- Le conversazioni web mobile ora mantengono stabili lo scorrimento touch, la misurazione del Markdown
  in streaming, gli swipe tra schede, i controlli compatti del composer e gli overlay responsive
  attraverso gesti nativi, rotazione e layout per schermi piccoli.
- Le sessioni possono portare un'intera conversazione nel modello attualmente selezionato
  quando rientra nel limite di contesto di quel modello, mentre l'utilizzo del contesto e i dettagli
  ereditati della route restano espliciti.
- I gruppi di strumenti della trascrizione preservano le chiamate originali, gli argomenti, gli output e
  lo stato di completamento per un'ispezione dettagliata, con anteprime delle immagini localizzate e
  una presentazione dell'attività più chiara.

## v0.9.145 - 2026-08-21

- Le sessioni web mobile ora mantengono stabili la scala nativa del viewport, il recupero dell'associazione, la proiezione
  dello stato remoto e lo scorrimento della trascrizione attraverso gesti touch,
  misurazioni delle righe in streaming, ripristini dell'app e connessioni lente.
- I riquadri desktop, gli aggiornamenti del controllo del codice sorgente, l'attività degli strumenti, le superfici dei comandi e
  lo stato delle sessioni si riprendono in modo più coerente preservando i layout responsive
  e un feedback più chiaro di caricamento o interruzione.
- L'instradamento degli strumenti degli agenti ora applica protezioni degli argomenti più strette, criterio di mutazione Git,
  gestione del prefisso del provider, proiezione delle prove e recupero dell'output della shell
  nel runtime condiviso e nella TUI.
- Gli strumenti di rilascio, benchmark, localizzazione e diagnostica ora convalidano i loro
  contratti con una copertura di regressione più ampia e report runtime più compatti.

## v0.9.144 - 2026-08-21

- L'interazione desktop ora segue in modo più affidabile il focus di tastiera e puntatore,
  migliora gli swipe dei riquadri mobile e la presentazione di trascrizione/stato, e riporta
  lo stato dei task shell in background con un recupero più sicuro.
- I riquadri dei diff Git rivelano subito il proprio stato di caricamento, uniscono
  gli aggiornamenti sovrapposti e rendono il testo del repository senza invocare i comandi
  diff esterni o textconv configurati.
- Solo è ora il workflow predefinito, le regole d'uso degli strumenti preservano le prove mentre
  raggruppano il lavoro in modo più serrato, e le finestre read/grep limitate riducono il contesto
  non necessario senza nascondere la paginazione.

## v0.9.143 - 2026-08-20

- L'esecuzione delle sessioni ora condivide un unico worker runtime supervisionato invece di un pool
  di shard di processi. Gli agenti in background restano in-process, le attese del provider cedono
  il loro slot locale di ammissione CPU, e i limiti di spawn a livello di macchina e il
  recupero dello stato di salute del runtime restano applicati.
- Le approvazioni dei dispositivi remoti compaiono solo mentre Impostazioni → Connessione è aperta,
  recuperano le richieste in sospeso all'apertura di quel pannello, e terminano solo dopo che il
  browser ha dimostrato la propria connessione E2EE autenticata.

## v0.9.142 - 2026-08-20

- Il packaging desktop per Linux convalida l'architettura di destinazione nella directory di prebuild ABI
  che `node-pty` carica effettivamente, mentre i pacchetti compilati per Windows e
  macOS mantengono il loro percorso di convalida `build/Release`.

- Le app web installate riprendono una sola approvazione desktop in sospeso attraverso i ricaricamenti, mentre il
  desktop sostituisce i prompt obsoleti, li fa scadere con la richiesta del relay, e
  accetta ogni decisione solo dopo che il servizio la conferma.
- FastDirect riusa i target di build aggiornati, una cache persistente del renderer di produzione,
  l'output del runtime preparato e un template di shell ASAR estratto. I deploy live del
  relay calcolano in modo indipendente le impronte delle modifiche a renderer/server e caricano
  solo i delta del renderer verificati prima dello swap atomico sul VPS.
- Il codice inline segue il carattere e la dimensione della prosa circostante, lasciando il colore come
  sua unica distinzione inline mentre i blocchi di codice delimitati restano monospazio.

## v0.9.141 - 2026-08-20

- La creazione di task desktop funziona con Electron 41 e Node 24: il router degli shard degli agenti
  ora copia gli export ESM immutabili del session-manager in una facciata scrivibile prima di installare
  i suoi override delle sessioni remote.

## v0.9.140 - 2026-08-20

- Le eliminazioni in Studio hanno effetto al primo clic: un'esecuzione terminata rilascia il suo
  slot della griglia non appena il suo asset è indicizzato, così eliminare quell'asset non
  fa più rivivere lo slot come tessera fantasma "generating". La galleria non è più
  limitata a 2,000 voci — un asset lascia lo store solo con un'eliminazione esplicita — e
  un'esecuzione che fallisce, parte senza job o perde il suo snapshot runtime
  ora lo riporta invece di girare in silenzio.
- Il selettore di schede mobile si legge come una griglia di card e guadagna un campo filtro solo
  quando l'elenco è abbastanza lungo da richiederne uno, mentre il chrome del telefono riformula i dischi del composer,
  l'isola di stato e i fogli dei pannelli in proporzioni touch e
  porta alla portata del dito i controlli visibili solo al passaggio.
- Un'app web installata può associarsi da sola: apre un URL di ingresso instradato sul dispositivo,
  chiede l'approvazione a quel desktop dietro un codice di due cifre mostrato su entrambi gli
  schermi, e riceve il materiale di associazione sigillato alla propria chiave usa e getta.
  I browser associati ora registrano quali corsie push leggono, così un telefono
  connesso non paga più per il traffico di terminale, editor e file che non mostra mai.
- Il server di ricerca code-graph serve i client a pipe condivisa con code di risposta per
  connessione e id di richiesta con ambito client, e termina da solo dopo una finestra
  di inattività così un proprietario terminato forzatamente smette di lasciare server caldi in giro.
- Le chiamate agli strumenti sopravvivono al rumore negli argomenti del provider: un percorso base opzionale omesso
  si risolve nel Progetto corrente invece di far fallire la chiamata, gli argomenti dei task
  sono ristretti all'azione scelta, e l'output di git mantiene il frame di avanzamento finale
  e la riga fatal finale invece di seppellire il motivo sotto i frame di
  ridisegno.
- Il renderer carica un solo catalogo della lingua dell'interfaccia invece di undici, stabilisce la
  lingua prima che il primo modulo dell'app venga valutato, e precarica un chunk di superficie alla selezione; /inherit porta una
  conversazione esistente in una nuova sessione sulla route attualmente selezionata.
- I crediti di terze parti sono portati da LICENSES e NOTICE soltanto.

## v0.9.139 - 2026-08-20

- Antigravity OAuth arriva come provider: un solo accesso Google espone Gemini 3.x
  e Claude tramite il gateway Cloud Code Assist, con accesso, rinnovo del token
  e failover degli endpoint secondo la forma esistente dei provider OAuth.
- Gli agenti ora hanno esattamente due stati, un modello fissato o spento, e Ricerca web
  risolve il Modello principale quando la sua route è lasciata non impostata.
- I browser associati raggiungono la superficie operativa del desktop — istruzioni di progetto,
  navigazione delle cartelle e luoghi, e il contratto git — tramite un unico modulo condiviso di
  convalida degli argomenti, mentre lo stato di sessione del relay viaggia come delta compatti con ambito client
  dentro frame E2EE binari.
- L'app web ora distribuisce asset brotli e gzip precompressi, trattiene i warmup in background
  e i font su collegamenti a consumo o lenti, ridimensiona gli allegati immagine e l'audio di dettatura
  prima del caricamento, elimina la sfocatura live dell'isola di stato fissata sui telefoni, e dipinge
  l'accento del marchio in blu Google.
- Il packaging di runtime e asar su Windows sopravvive agli script del ciclo di vita del repo e ai
  blocchi transitori dei file da parte dell'antivirus, e la riga di stato della TUI calcola direttamente il
  conteggio delle shell in esecuzione sul percorso istantaneo.

## v0.9.138 - 2026-08-19

- Le sessioni web remote ora usano sottoscrizioni con ambito client, frame E2EE binari,
  delta compatti di stato/catalogo, batching del terminale e sonde di latenza di disegno,
  riducendo il volume di trasferimento e preservando il recupero live su collegamenti lenti.
- Lo scorrimento della trascrizione web e l'input del composer restano visivamente stabili durante
  snapshot remoti concorrenti, cambi di sessione e rendering mobile.
- Il contesto runtime, il recupero delle richieste ai provider, le notifiche dei task in background
  e il ripristino dei completamenti sono rafforzati nelle sessioni di lunga durata.

## v0.9.137 - 2026-08-19

- Il recupero della riconnessione remota ora aggiorna i cataloghi delle sessioni e le corsie
  di trascrizione montate, e il controllo di aggiornamento apre il gruppo di pulsanti della barra del titolo.

## v0.9.136 - 2026-08-19

- Il ritirato impianto di messaggistica Discord/Telegram e di sessioni di canale è rimosso,
  mentre le barre di sistema mobile restano costantemente nere.

## v0.9.135 - 2026-08-18

- Il desktop ora preserva i layout dei riquadri, lo stato della barra laterale, la geometria dei pannelli e
  le bozze del composer attraverso ricaricamenti e riavvii FastDirect, con una copertura di
  regressione del renderer ampliata.
- L'esecuzione della shell ora rafforza la pulizia dell'ambiente, lo standby caldo, il recupero del
  completamento in background, la gestione dei processi nativi e l'instradamento degli strumenti nelle
  sessioni interattive e headless.
- Le release Linux dello spawn nativo sono collegate staticamente, la ricerca nel grafo e i report di recall
  sono rafforzati, e l'instradamento di Terminal Bench e gli strumenti di report sono
  aggiornati.

## v0.9.134 - 2026-08-17

- Il desktop ora distribuisce il marchio selezionato, un editor unificato delle route dei modelli con
  parametri del modello e ordine dell'elenco persistente, e decomprime node-pty accanto al
  daemon pacchettizzato.
- La compattazione delle sessioni è vincolata rigidamente dal proprietario: le sessioni degli agenti restano semantiche,
  le sessioni utente usano recall-fasttrack. Le impostazioni non elencano più le Memorie core
  (vivono nel progetto), e l'inventario di accettazione di Windows corrisponde.

- Le integrazioni di provider e strumenti ora includono il ciclo di vita OAuth e il recupero dei token
  per Anthropic, Cursor, Grok e OpenAI, la normalizzazione degli schemi degli strumenti specifica per Grok,
  e il fan-out scomposto di percorsi/pattern di search e grep.
- L'orchestrazione delle sessioni e i workflow della TUI ora applicano l'ambito della sessione proprietaria,
  preservano le schede di consegna completata e di completamento in background attraverso i ripristini,
  mantengono i prompt in coda esternalizzati e classificano gli esiti tra errori
  di comando, errori degli strumenti e mancate corrispondenze benigne.
- La navigazione dello spazio di lavoro desktop ora preserva i titoli delle sessioni dei riquadri durante le interazioni
  di trascinamento, aggiunge nuovi tentativi di ripristino dello spazio di lavoro all'avvio a freddo che impediscono
  la perdita di schede, e aggiorna i pannelli di onboarding e di configurazione delle capacità.

## v0.9.133 - 2026-08-16

- La proiezione delle prove solo per provider ora assegna alias ai percorsi di file tipizzati ripetuti
  all'interno delle epoche di mutazione, preservando gli envelope esatti degli strumenti e i percorsi
  ricostruibili e riducendo il contesto cumulativo nelle sessioni lunghe.
- L'esecuzione di Git ora condivide un unico criterio di mutazione tra orchestrazione e
  proiezione delle prove, serializza le scritture a livello di repository rispetto alle modifiche dei file,
  usa processi nativi di proprietà dell'albero e rende annullabili i lock in coda.

## v0.9.132 - 2026-08-16

- L'esecuzione degli strumenti ora espone lo stato di uscita completo della shell, aggiunge una superficie Git
  dedicata, rafforza la creazione atomica delle patch e la diagnostica, e migliora l'
  integrità di ricerca, elenco, code-graph e grafo nativo sotto carico concorrente.
- La compattazione delle sessioni, il recupero di provider/immagini, il tracciamento delle prove, lo stato di salute degli shard
  e la pulizia del runtime Lead ora preservano lo stato attraverso i guasti senza mascherare
  i worker degradati né innescare lavoro di fallback non necessario.
- L'instradamento desktop, l'attività degli agenti, lo stato dei riquadri ripristinati e il rendering
  del Markdown in streaming ora restano reattivi e visivamente coerenti nelle conversazioni
  live e riprese.

## v0.9.131 - 2026-08-14

- I gate di rilascio ora vengono eseguiti automaticamente con selezione incrementale dei percorsi, i runtime
  di piattaforma desktop si preparano prima del packaging, le build del grafo nativo usano un
  profilo riproducibile più veloce, e il deploy web/relay di produzione include
  rollback atomico e verifica di hash e stato di salute.
- Le corsie di rilascio desktop ora si pacchettizzano non appena il loro runtime corrispondente è pronto,
  le cache del compilatore del grafo restano isolate tra le build di riproducibilità, le installazioni
  del relay sono fissate dal lockfile, e i tempi di rilascio avvisano sulle regressioni del 10%.
- La pulizia degli agenti non scambia più le proiezioni del pool Lead per worker figli, così
  eliminare un altro runtime non può chiudere la conversazione desktop attiva né
  scartare un messaggio di follow-up accettato.

## v0.9.130 - 2026-08-14

- Il recupero di provider e sessioni ora classifica in modo coerente i guasti transitori degli stream,
  ritenta i turni rifiutati per immagini senza perdere l'intento dell'utente, e
  preserva interruzione, riepilogo e stato dell'esito terminale attraverso i trasporti Gemini
  e OpenAI.
- I guasti degli strumenti sono persistiti senza inquinamento dalle tracce di test, il criterio shell evita
  falsi positivi su script tra virgolette, e i percorsi nativi di search/read/list/stat condividono
  lavoro annullabile preservando l'invalidazione fresca del watcher e il comportamento esatto di
  grep/glob su file sotto carico.
- Studio desktop, utilizzo, attività degli agenti, layout dei riquadri, localizzazione e presentazione
  dei tag dei worker ora restano allineati tra sessioni ripristinate e live.

## v0.9.129 - 2026-08-14

- L'exec headless ora esegue per impostazione predefinita una vera superficie solo: gli strumenti di ricerca web e
  memoria restano spenti a meno che --web-search / --memory non li riattivino, i
  processi figli della shell ereditano un proxy no-egress imposto (il loopback resta
  raggiungibile), e la riga di ambiente della sessione dichiara network=offline così
  i modelli non tentano mai l'accesso al web.

## v0.9.128 - 2026-08-14

- Gli strumenti di esplorazione ora terminano al round di ricerca: grep spende il suo budget di output
  su blocchi sorgente ordinati (prima le corrispondenze dei rami rari), find scarta i
  risultati fuzzy fatti solo di rumore, e gli outline dei simboli di code_graph filtrano prima di
  limitare e rispettano le richieste di corpo.
- La guida agli agenti raggruppa una chiamata meglio instradata per incognita invece di un
  fan-out speculativo multi-strumento, riducendo di un terzo l'uso di token dei benchmark senza
  variazioni del tasso di successo.
- Rafforzamento del recupero delle sessioni e della resilienza del runtime nella ricerca nativa,
  nel contratto della shell e negli strumenti read/list.

## v0.9.127 - 2026-08-14

- I binari nativi ora hanno un'unica casa canonica in GitHub Releases: npm distribuisce
  solo la CLI, mentre le esecuzioni della CLI verificano e mettono in cache gli asset su richiesta e le build Desktop
  incorporano gli stessi asset di piattaforma verificati.

## v0.9.126 - 2026-08-14

- La ricerca nativa ora gestisce l'intero contratto interno grep/find, preserva
  gli errori di recupero delle regex, e sovrappone la ricerca del primo turno al warmup del code-graph.

## v0.9.125 - 2026-08-13

- L'esecuzione di shell e task in background ora usa un unico gestore di processi nativo con hash fissato
  su Windows, Linux e macOS, senza fallback su ambiente, build locale,
  registro di file, shell in standby o processo Node.
- I percorsi nativi di ricerca, patch, download, media, recall, webhook e sessione ora
  impongono risorse limitate, una proprietà più rigorosa e controlli rafforzati su trasporto e
  catena di fornitura dei rilasci.
- L'estrazione del runtime della Memoria ora accetta i link verificati interni all'archivio rifiutando
  comunque path traversal, link esterni e voci tar speciali.
- Il comportamento di progetti, terminale, aggiornamenti, associazione remota, relay e riquadri del desktop
  ora include le correzioni consolidate di sicurezza, recupero e layout responsive.

## v0.9.124 - 2026-08-12

- L'attività degli agenti desktop ora raggruppa ogni sessione attiva indipendentemente dalla
  scheda in primo piano, mentre i riquadri di sessione ripristinati si pre-riscaldano correttamente e le sessioni
  esistenti accettano input successivo senza attendere la conferma dell'host.
- Il trasporto delle sessioni di desktop e daemon ora sopravvive alle race di avvio, alle sessioni di controllo
  obsolete, alla perdita transitoria del socket e al recupero dello stream sul posto
  mantenendo la proprietà remota globale al cambio del focus della sessione.
- Le preferenze di commit Git ora separano l'esempio visibile dalle istruzioni
  per l'IA, serializzano i salvataggi sovrapposti, e convalidano e poi correggono l'output
  Conventional Commit prima di accettarlo.
- La memoria core ora rispecchia il contesto curato e generato in un file atomico
  protetto da revisione così le sessioni possono caricare memoria con ambito senza avviare a freddo
  il runtime della memoria, con le mutazioni che aggiornano lo specchio.
- L'ancoraggio della trascrizione TUI e la gestione della selezione con Esc evitano salti visivi
  e ripristini accidentali della coda, mentre il fallback di rifiuto di Terminal-Bench segue
  il motivo di terminazione del runtime anche dopo la narrazione in streaming.

## v0.9.123 - 2026-08-12

- La configurazione dei provider desktop ora recupera le sessioni di controllo obsolete senza esporre
  errori di trasporto grezzi, e la cronologia dei prompt si attiva solo da una bozza vuota.
- La ricerca dei percorsi evita scansioni complete a freddo dell'albero, unisce i prewarm del watcher, e
  stringe le scadenze della ricerca nativa, la concorrenza in blocco e gli snapshot dei processi.
- La guida al timeout della shell asincrona ora distingue il lavoro in background illimitato dalle
  scadenze di kill esplicite.

## v0.9.122 - 2026-08-11

- Le regole di instradamento degli strumenti ora centralizzano le convenzioni dei percorsi, rimuovono la guida
  duplicata sul batching e richiedono l'ispezione di sola lettura solo quando le prove sono a rischio.
- Il preflight dei benchmark Anthropic ora risolve correttamente gli import del provider dagli snapshot
  temporanei isolati dell'harness.

## v0.9.121 - 2026-08-11

- Le regole di esecuzione degli strumenti e la diagnostica della shell ora distinguono le mancate
  corrispondenze di percorso conclusive, si fidano degli envelope verificati, mantengono i controlli dei valori nello stesso turno e
  fanno emergere i fatti command-not-found da stderr.
- La virtualizzazione della trascrizione desktop ora fissa gli estremi della selezione di testo nativa
  durante l'autoscroll del trascinamento, mentre i launcher delle utilità allineano icona e testo
  in righe dimensionate sul contenuto.

## v0.9.120 - 2026-08-11

- I task shell in background ora mantengono la loro sessione proprietaria e il daemon dopo che ogni
  vista si è staccata, così l'espulsione per inattività non può annullare il task prima che il suo completamento
  venga consegnato.

## v0.9.119 - 2026-08-11

- Le build di riproducibilità Native Graph e Token ora vengono eseguite su runner indipendenti
  in parallelo, mentre i caricamenti DMG e ZIP per macOS Intel si sovrappongono e abbandonano
  tempestivamente i trasferimenti bloccati.
- La navigazione dei progetti desktop, le superfici delle utilità, il focus della trascrizione e il comportamento della
  virtualizzazione vendorizzata sono rifiniti insieme a stili di esecuzione degli strumenti più stretti
  e al riuso dei processi del filesystem.
- La gestione degli allegati Discord e Telegram preserva la consegna di media limitata
  e convalida direttamente il comportamento dei caricamenti Telegram.

## v0.9.118 - 2026-08-11

- Il desktop consolida Agenti, Ricerca e Source Control nel dock delle utilità,
  mantiene selezionato Utilities mentre avvia strumenti, e allinea il trattamento di avvisi
  e errori tra le schede degli strumenti ripristinate e live.
- L'elenco dei file e la ricerca nativa ora uniscono l'enumerazione concorrente, supportano
  richieste persistenti annullabili e snapshot dei processi, e preservano il comportamento di
  fallback limitato sotto un forte fan-out sul filesystem.
- Il batching di code-graph, il riuso dello standby di PowerShell, il tracciamento dell'albero dei processi shell
  e l'invalidazione della cache sono rafforzati contro lavoro concorrente e stato obsoleto.

## v0.9.117 - 2026-08-11

- L'invio dei prompt desktop ora supporta l'accodamento immediato con Invio e il ripristino preciso
  con Esc di testo e allegati in sospeso, mentre lo scorrimento della trascrizione
  differisce le correzioni del virtualizzatore durante il movimento attivo del lettore.
- Desktop Utilities ora presenta launcher diretti per Studio, Terminale ed Explorer
  con descrizioni localizzate, mentre la barra delle attività usa l'identità creativa
  di Utilities e una presentazione dell'utilizzo rinnovata.
- Le azioni di canale rivolte al modello ormai obsolete e il loro impianto di provider-dispatch
  sono rimossi così il catalogo di strumenti pubblicizzato corrisponde alla superficie runtime.
- La guida all'esecuzione degli strumenti stringe le prove in batch e la verifica nello stesso turno,
  mentre le raffiche concorrenti di filesystem, grafo, patch e shell guadagnano la gestione
  limitata di threadpool, corsie di spawn e pressione di raggiungibilità.

## v0.9.116 - 2026-08-11

- L'analisi dei round H5 di Terminal-Bench aggiunge le tracce dei task premiati e i conteggi aggregati
  dei round per il confronto finale ad alto sforzo.

## v0.9.115 - 2026-08-11

- L'analisi dei round H4 di Terminal-Bench registra le sonde dei task riusciti ad alto sforzo
  e la loro cadenza di recupero, patch e verifica.
- La guida all'esecuzione degli strumenti ora tratta i fatti del task e i controlli comprovati come stato
  noto durevole e mantiene la verifica delle patch nello stesso turno di esecuzione.

## v0.9.114 - 2026-08-11

- Le identità di strumenti ipotizzate ora vengono verificate prima delle chiamate dipendenti, con un'analisi
  dei round H3 di Terminal-Bench che registra i pattern di recupero risultanti.

## v0.9.113 - 2026-08-11

- La guida agli strumenti ora raggruppa campioni di prove distinti ed evita attivazioni ridondanti
  di strumenti differiti o di progetto, con l'analisi dei round di Terminal-Bench che
  cattura i pattern residui di sonde seriali.

## v0.9.112 - 2026-08-11

- Le superfici di utilità, attività, trascrizione, impostazioni e repository del desktop sono
  semplificate attorno a una configurazione mirata delle funzionalità e a regressioni compatte.
- Il recupero dei provider, la diagnostica di shell/elenchi e la verifica dei rilasci sono
  consolidati in suite più piccole critiche per la spedizione senza indebolire i loro contratti di
  trasporto, asset o packaging.

## v0.9.111 - 2026-08-11

- La navigazione del repository ora usa direttamente la superficie di strumenti integrata senza un
  agente explorer separato, riducendo l'overhead di instradamento e la configurazione legacy.
- Le decisioni di nuovo tentativo di OpenAI WebSocket preservano gli errori attuali di autenticazione, throttling e
  annullamento, mentre il recupero del trasporto delle sessioni e la deduplicazione dei completamenti
  sono rafforzati.
- Il batching degli strumenti, il fan-out del grafo, la segnalazione dell'avanzamento e il comportamento di trascrizione,
  impostazioni e dock delle utilità del desktop sono semplificati con regressioni mirate.
- I profili Terminal-Bench 2.1, le esecuzioni riprendibili, gli snapshot immutabili dell'harness e
  la contabilità dei costi sono stretti per confronti nativi riproducibili.

## v0.9.110 - 2026-08-11

- I trasporti dei provider ora limitano gli stalli non-stream di Anthropic, distinguono i
  guasti di trasporto ritentabili dai rifiuti del modello, preservano la continuità del ragionamento
  OpenAI al recupero e pre-riscaldano le sessioni WebSocket compatibili.
- Gli strumenti patch, list e shell recuperano in una sola chiamata le discordanze univoche di percorso o contesto
  mantenendo le protezioni su ambiguità, collegamenti simbolici e comandi distruttivi.
- Il completamento dei titoli delle sessioni e la gestione del fallback della sorgente Markdown sono più
  resilienti, con regressioni mirate su provider, renderer, strumenti e instradamento.
- La diagnostica di Terminal-Bench 2.1, le baseline native eque, la contabilità dell'utilizzo e
  gli esperimenti riproducibili di replay del ragionamento sono ampliati.

## v0.9.109 - 2026-08-10

- I comandi shell che terminano con uscita diversa da zero sono trattati come risultati di comando
  anziché come errori dello strumento, con stato coerente tra runtime e TUI.
- L'instradamento degli strumenti, i limiti dell'explorer, i contratti degli stili di output e le loro suite
  di regressione sono stretti per evitare lavoro ridondante preservando report concisi
  rivolti all'utente.
- Le radici delle patch compatte ora stabiliscono sia il confine di scrittura sia il sistema di coordinate
  dei percorsi relativi, con una guida al recupero più chiara.

## v0.9.108 - 2026-08-10

- L'analisi delle patch compatte accetta i wrapper legacy Begin/End attorno alle sezioni
  compatte lasciando invariato l'input V4A canonico.

## v0.9.107 - 2026-08-10

- Le sessioni di automazione non interattiva e di benchmark usano esplicitamente il contesto di approvazione
  implicita, mentre i workflow interattivi mantengono il loro gate di approvazione dell'utente.

## v0.9.106 - 2026-08-10

- I client MCP, la scoperta degli strumenti, le istruzioni, l'esecuzione, l'aggiornamento differito e
  lo smantellamento sono isolati per ambito runtime così server con lo stesso nome non possono trapelare
  tra sessioni concorrenti o agenti standalone.

## v0.9.105 - 2026-08-10

- L'accesso remoto è solo tramite app web: il ritirato pacchetto Capacitor/Android,
  le route di download dell'APK, gli hook della shell nativa e il collegamento delle versioni di rilascio mobile
  sono rimossi, mentre il deploy del relay guadagna un passaggio esplicito di staging del renderer.
- Le chiamate degli strumenti ora normalizzano gli input del progetto corrente in percorsi relativi compatti,
  rifiutano in modo coerente ambiti non corrispondenti o ridondanti e preservano la parità
  tra i contratti di shell, patch, grafo, explore e degli strumenti integrati.
- Il report del contesto separa l'utilizzo visibile al provider dalla pressione di compattazione
  e dalla riserva configurata, mentre il thinking adattivo di Anthropic lascia la sua modalità di visualizzazione
  all'API a meno che un operatore non la sostituisca esplicitamente.
- Le bozze dei nuovi task mantengono la propria scheda di progetto quando si seleziona o registra un
  progetto, e i cambi Fast riusciti della sessione preimpostano la bozza corrispondente successiva
  senza sostituire una scelta di modello diversa.

## v0.9.104 - 2026-08-09

- L'instradamento degli strumenti ora localizza una sola volta le coordinate ignote del repository, assegna ogni
  sfaccettatura di prova a un solo strumento dedicato, raggruppa solo chiamate indipendenti, e
  mantiene le modifiche al testo e la verifica dietro la barriera di esecuzione delle patch.
- L'ispezione delle directory espone dotfile e metadati dei file senza esplorazione
  Shell, mentre i workflow senza delega omettono il brief Lead inutilizzato e
  usano una superficie di strumenti più piccola e allineata alle capacità.

## v0.9.103 - 2026-08-08

- Le superfici di navigazione, composer, Studio, impostazioni e trascrizione del desktop ora
  condividono un layout responsive più stretto, con un inseguimento dello scorrimento virtuale più solido,
  gestione dei file locali e una copertura di regressione DOM ampliata.
- Il renderer remoto viene distribuito come app web installabile con un manifest stabile,
  icona e service worker solo di rete, mentre il relay serve quegli asset
  con i tipi di contenuto richiesti per manifest e service worker.
- L'esecuzione Solo non porta più le definizioni di agente obsolete per debugger, task dello scheduler o
  gestore di webhook e rimuove il loro protocollo di instradamento/cache ormai superato, mantenendo i servizi integrati
  separati dagli agenti personalizzati modificabili.
- La generazione di immagini Codex ospitata seleziona esplicitamente lo strumento immagine per i modelli
  supportati, con copertura mirata del corpo della richiesta.

## v0.9.102 - 2026-08-08

- Incremento di versione di manutenzione; nessuna modifica funzionale rispetto a v0.9.101.

## v0.9.101 - 2026-08-08

- Esc ora richiama nel composer i messaggi in coda ancora non elaborati
  prima di qualsiasi altra cosa — prima l'ordine della coda — così un Esc a metà turno modifica
  il follow-up in attesa invece di interrompere il turno; una seconda pressione annulla comunque.
- I workflow sono pure definizioni di stile di lavoro: i pacchetti non portano più un elenco
  di agenti. Ogni agente definito (integrato e personalizzato) è disponibile a qualsiasi workflow
  che delega, Solo resta privo di delega tramite `delegation: none`, e
  l'eliminazione di un agente personalizzato lo rimuove da ogni superficie in una volta sola, compreso lo
  spawn per nome.
- Impostazioni → Generale ha guadagnato interruttori indipendenti per Ricerca web, Explorer e Memoria;
  Memoria ora controlla gli strumenti memory/recall più l'iniezione della memoria core,
  mentre i cicli di memoria in background sono passati a Contesto come interruttore a sé.
- Le esecuzioni di ruolo headless e le sessioni di bench partono con explorer, ricerca web e
  memoria spenti (superficie classica) e si riattivano per esecuzione tramite flag o
  variabili MIXDOG_FEATURE_*.
- La policy condivisa degli strumenti elimina il round obbligatorio di verifica dopo la modifica,
  prende la prova sufficiente più economica per ogni ricerca e definisce explore come una
  semplice ricerca nei sorgenti su alberi di sorgenti e file con un solo target concreto per
  query.

## v0.9.100 - 2026-08-07

- Lo stile del comando di contesto non dipende più dall'apertura preventiva delle Impostazioni né
  collide con la classe di contesto globale di Monaco, e il riaggancio della trascrizione non
  annulla più un piccolo movimento della rotellina del lettore.
- I packager desktop ora ripristinano i download npm con una chiave di cache solo per le dipendenze,
  così i timbri di versione del rilascio non avviano a freddo ogni installazione di piattaforma.
- Le bozze nascoste sono trattate come lavoro riprendibile anziché come release pubblicate,
  evitando che i rilasci falliti consumino una versione patch in più.

## v0.9.99 - 2026-08-07

- La tipografia della trascrizione desktop ora separa contenuto, stato operativo e
  metadati in una gerarchia più stabile, mentre Fast usa un'icona compatta con stato.
- Il recupero dell'explorer ora fa il fan-out una volta di ogni sfaccettatura concreta del localizzatore, preserva
  letteralmente i percorsi restituiti e interrompe il recupero limitato invece di restituire un
  ancoraggio debole o ricostruito.
- Le letture sincrone del catalogo dei modelli non avviano più una richiesta di rete globale implicita.
  Il warmup della sessione resta l'unico proprietario dell'I/O del catalogo remoto, così i
  trasporti iniettati dal provider restano ermetici su un'installazione a freddo.
- La corsia di rilascio isolata ora prepara esplicitamente un unico runtime nativo di code-graph verificato
  invece di dipendere da un binario ambientale lasciato da un job precedente.
- Gli asset di rilascio per macOS Intel usano upload HTTP/1.1 limitati, file per file, con
  controlli di completamento remoto e nuovi tentativi, evitando che un singolo trasferimento CLI bloccato
  trattenga l'intero rilascio indefinitamente.
- Il recupero dei rilasci non pubblicati della stessa versione ora riversa le sue note accumulate
  in quella versione prima di pubblicare invece di lasciare il lavoro distribuito marcato
  come Unreleased.

## v0.9.98 - 2026-08-07

- L'associazione remota del browser ora stabilisce un canale autenticato cifrato end-to-end
  prima che qualsiasi stato di sessione, dato del terminale o payload RPC possa attraversare il
  relay; le corsie media non cifrate restano chiuse.
- Gli allegati desktop preservano identità e metadati dei file attraverso il confine
  di sessione, con estrazione limitata di immagini/PDF e normalizzazione condivisa dei media
  per gli input dei provider.
- L'onboarding desktop e i relativi testi delle impostazioni sono localizzati in ogni lingua
  distribuita, mentre la composizione IME, il follow della trascrizione virtuale e
  i controlli della fast mode si comportano in modo coerente nei riquadri di lunga durata.
- Il recupero delle sessioni, la consegna dei messaggi in sospeso, la cache del catalogo dei provider, la generazione
  dei titoli, gli snapshot dei worktree e le metriche runtime limitate sono stretti
  attorno al servizio di sessione unificato.
- La convalida del rilascio è divisa in corsie parallele, la compilazione desktop si sovrappone
  ai gate, i runtime preparati sono messi in cache, e i pacchetti di piattaforma vengono caricati su una sola
  bozza nascosta prima della pubblicazione atomica. Le dipendenze solo-renderer non sono più
  duplicate nell'archivio desktop, riducendo l'installer Windows di circa un terzo.

## v0.9.97 - 2026-08-07

- Il protocollo di sessione 1 ora porta un indice di compatibilità esplicito, permettendo ai
  client più recenti di rifiutare daemon più vecchi mentre i client più vecchi possono collegarsi tramite la
  superficie di compatibilità supportata senza stack engine/backend paralleli.
- I flussi desktop, terminale, canale, OAuth e memoria ora condividono il daemon di sessione
  unificato a livello di macchina; i trasporti engine/backend obsoleti, i fallback
  e gli shim di compatibilità sono stati rimossi dalla linea di sviluppo.
- La proprietà delle sessioni e i gate del carico degli strumenti ora coordinano il lavoro parallelo di shell,
  patch, read, code-graph, memoria e canale con ammissione equa,
  I/O duplicato ridotto e una copertura più solida di annullamento/recupero.
- Il focus multi-riquadro del desktop, il trascinamento delle schede, lo stato di revisione, le notifiche, i nomi
  dei provider, la diagnostica dell'updater e il packaging degli aggiornamenti di sviluppo sono stati
  stretti, con test di regressione ampliati per renderer e trasporto delle sessioni.
- I comandi di riproduzione di Terminal-Bench e la convalida dei costi ora puntano
  all'esatta esecuzione archiviata e falliscono chiaramente quando un insieme di prove richiesto è assente.

## v0.9.96 - 2026-08-07

- La disciplina di rilascio ora richiede che ogni pacchetto dell'app sia pre-incrementato quando
  cambia il protocollo wire dell'engine, mantiene sincronizzate le versioni dei workspace e
  pubblica quell'identità in sospeso senza un secondo incremento accidentale.
- Le superfici di sviluppo e installate continuano a condividere lo store esistente di dati e
  autenticazione; la disciplina di protocollo/versione impedisce lo sfasamento del daemon alla stessa versione
  senza nascondere le credenziali dietro un nuovo profilo.
- La convalida dei rilasci ora controlla il packaging di piattaforma e rimuove un'esecuzione duplicata
  di code-graph, evitando cinque costosi job di pacchetto quando un gate mirato fallisce.
- I conflitti di protocollo del desktop ora spiegano il percorso di recupero aggiorna/chiudi-e-riapri
  invece di far emergere un'eccezione grezza del trasporto di sessione.
- Il daemon unificato del protocollo 1 rimuove l'host di sessione desktop duplicato,
  ripristina il comportamento di riconnessione/risincronizzazione del daemon e preserva il lavoro completato degli strumenti
  attraverso i confini di timeout e annullamento.

## v0.9.95 - 2026-08-06

- Un processo globale della macchina possiede ogni sessione live, e il TUI del terminale più
  ogni finestra desktop si collegano come viste su un trasporto HTTP+SSE 127.0.0.1, così
  non c'è alcun ruolo proprietario/spettatore da negoziare tra le superfici.
- I prompt inviati non possono più andare persi tra le superfici. L'invio di una vista del daemon
  mantiene la sua risposta sincrona ma viene ritentato finché l'engine non lo prende
  (e riconsegnato dopo un riavvio del daemon), un invio in live-share viene
  confermato dal proprietario e ripiega sullo spool durevole quando viene
  rifiutato o non confermato, e la coda scarta un id di invio riconsegnato
  invece di pubblicare il messaggio due volte.
- Modifica cross-client: riprendere una sessione che un'altra vista già detiene adotta
  quell'engine live invece di caricare una seconda copia, i frame dell'engine si diffondono a
  ogni vista, e un engine termina solo con il suo ULTIMO spettatore — così un terminale e
  una finestra desktop possono guidare una sessione turno per turno.

## v0.9.94 - 2026-08-05

- La barra delle schede del desktop restringe le schede insieme verso i minimi attivi/inattivi
  con ogni scheda visibile invece di scorrere, e le shell touch si comprimono in un
  elenco di selezione con titolo + conteggio.
- Il markdown in streaming ripara la coda live (`**`, `` ` ``, `~~` non chiusi)
  e limita il blocco di geometria dei blocchi di codice delimitati al proprio chunk, così titoli, elenchi
  e grassetto vengono formattati mentre il modello sta ancora scrivendo.
- La revisione del turno è passata nella timeline scorrevole (i diff del turno viaggiano con il
  thread), ponendo fine allo spostamento dello stack del composer all'ingresso nella sessione; gli
  avvisi di tono warn ora usano la coppia di stato ambra invece di quella neutra.
- La banda della didascalia nativa è trasparente così la barra del titolo DOM e gli scrim delle finestre
  la oscurano direttamente; la coppia ◀ ▶ di ciclo dei riquadri è ritirata (Alt+Sinistra/Destra mantiene
  il ciclo del focus) e le finestre dei progetti detengono il claim di oscuramento della barra del titolo.
- La cattura della UI desktop guida Nuovo task e Impostazioni tramite Ctrl+N / Ctrl+,,
  fissa la lingua di cattura e verifica il layout stretto delle impostazioni a 360px.
- Rifiniture della finestra di trascrizione TUI e dell'harness di jitter, più sonde di race
  nella selezione delle sessioni desktop.

## v0.9.93 - 2026-08-04

- Audit delle dipendenze portato a zero in core e desktop: `npm audit fix` per
  fast-uri, ip-address, hono/@hono/node-server, undici radice e
  brace-expansion; l'override annidato di undici di discord.js alzato a 6.28.0;
  l'override desktop `dompurify` `^3.4.12` elimina il lotto XSS di Monaco.
- Audit delle funzionalità del README: sezione workbench desktop, dettaglio del sottosistema di memoria,
  associazione QR del relay, cron con ore silenziose e trascrizione Whisper locale,
  sessioni parallele nei riquadri, procedura guidata di onboarding.
- Discord: rimosso l'ultimo comando slash registrato (`/stop`); l'avvio continua a
  cancellare gli insiemi di comandi globali/di guild obsoleti.
- Terminal-Bench 2.1: risultati corretti, grafici di confronto sostitutivi e
  script di riproduzione/verifica.
- CI: Deploy è ora l'unico punto di ingresso per i rilasci (supply chain dei token
  integrata, scorciatoie del push di tag rimosse) con un gate di rilascio del changelog.
- Versioni dei pacchetti unificate a 0.9.92 (mobile/relay allineati) e cronologia del
  repository compattata in una radice pulita.

## v0.9.92 - 2026-08-02

- Rilascio di base: pacchetto npm, installer desktop e asset nativi della
  supply chain (runtime, patch, graph, token, runtime vocale).

