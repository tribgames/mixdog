# Journal des modifications

Changements notables, du plus récent au plus ancien. Le pipeline Deploy refuse de publier tant que
la section Unreleased est vide, et l'estampille avec la version publiée.

## Unreleased

## v1.0.12 - 2026-10-10

- Le journal des modifications de Réglages > À propos liste les notes de la version installée ;
  dans la v1.0.11, il s'arrêtait encore à la v1.0.10, aussi bien dans l'application de bureau que
  sur la page web distante.

- Le journal des modifications est disponible dans toutes les langues de l'application, et après une
  mise à jour, l'application affiche une seule fois les nouveautés de cette version.

- Le raisonnement automatique est activé par défaut sur les modèles compatibles : chaque message et
  chaque étape d'outil reçoit l'effort de raisonnement dont il a besoin. Son modèle se télécharge en
  arrière-plan à la première utilisation plutôt qu'au démarrage, et la carte Intégré affiche le
  modèle et sa base.

- Les liens de fichiers d'une conversation s'ouvrent à côté d'elle, dans le panneau latéral, sous
  forme d'onglets. Un nouveau lien remplace l'onglet d'aperçu, si bien que les liens n'accumulent plus
  les onglets ; un onglet est conservé dès que vous double-cliquez dessus, choisissez Garder ouvert
  ou modifiez le fichier. Huit onglets de fichiers au plus restent ouverts. Réglages > Général >
  Aperçu des liens désactive ce comportement.

- Les fichiers CSV et TSV s'ouvrent sous forme de tableau modifiable : copier-coller de cellules,
  ajout ou suppression de lignes et de colonnes, enregistrement avec Ctrl+S, et annulation ou
  rétablissement avec Ctrl+Z et Ctrl+Y.

- Les fichiers PDF et Office (Word, PowerPoint, Excel) s'affichent en aperçu dans le panneau latéral.
  Les pages Office se rouvrent instantanément, et un lien lance la conversion de son document dès que
  vous le survolez.

- Les conversations peuvent être mises en favori : les favoris restent en haut de la liste des
  sessions, et l'étoile apparaît lorsque vous survolez une ligne.

- La recherche trouve du texte dans les conversations passées. Une conversation supprimée ne laisse
  aucun résultat de recherche, quelle que soit la façon dont elle a été retirée.

- Faire défiler vers le haut pendant qu'une réponse est diffusée conserve votre position au lieu de
  revenir brusquement en bas.

- Les actions GitHub d'une réponse sont regroupées dans une seule carte GitHub, et la boucle de
  l'indicateur de réflexion ne saute plus à son redémarrage.

- Les comptes de fournisseurs affichent leur e-mail de connexion, et reconnecter le même compte
  conserve son nom et son historique d'utilisation au lieu d'ajouter une nouvelle entrée. La boîte de
  dialogue d'utilisation ne liste plus les comptes déconnectés.

- Un prompt retiré de la file d'attente vers le brouillon ne réapparaît plus après un redémarrage, et
  rouvrir rapidement l'application garde la conversation modifiable au lieu de l'ouvrir en lecture
  seule.

- Corrections de traduction : des libellés erronés, comme Git en italien, Models en vietnamien et
  Effort en chinois et en japonais, s'affichent désormais correctement.

- Dans l'interface web du téléphone, Entrée insère un saut de ligne et le bouton d'envoi envoie.

- Memory démarre sur les profils Windows dont le nom de dossier utilisateur n'est pas en ASCII simple.

- Mises à jour de sécurité des dépendances image-size et js-yaml (CVE-2025-71329, CVE-2026-84375).

## v1.0.11 - 2026-10-08

- Le navigateur intégré affiche de nouveau les pages sur les écrans Windows dont la mise à l'échelle
  dépasse 100 %, au lieu d'échouer avec « Browser display did not recover after the
  page changed » (#8). Les pages suivent aussi les changements d'échelle d'affichage, y compris
  les onglets qui n'étaient pas à l'écran à ce moment-là.

- Les fichiers Word, PowerPoint et Excel (.docx, .pptx, .xlsx, .xlsm) peuvent être
  joints aux messages et aux automatisations, et leur texte parvient à tous les modèles.
  Les types de fichiers qui ne peuvent pas être joints l'indiquent désormais et insèrent le chemin
  du fichier à la place ; les fichiers vides ou qui ne sont pas de vrais PDF sont rejetés avec
  un message clair.

- Les PDF et les images situés plus tôt dans une conversation sont toujours envoyés au modèle
  après le redémarrage de l'application. Les modèles sans prise en charge native des PDF reçoivent
  le texte du PDF. La lecture d'un PDF de plus de 100 pages renvoie ses premières pages sous forme de texte,
  et les PDF protégés par mot de passe ou invalides renvoient une erreur claire au lieu de
  casser les requêtes suivantes.

- Les images et fichiers renvoyés par les outils MCP parviennent au modèle sous forme d'images et de fichiers
  au lieu de texte encodé brut ; les médias non pris en charge ou trop volumineux sont décrits.

- Les résumés créés lors du compactage d'une longue conversation incluent désormais les messages
  longs et signalent les images et fichiers joints.

- Les modèles locaux en texte seul conservent le texte des documents joints, et les images
  antérieures deviennent une courte note au lieu d'interrompre la conversation.

- Des commentaires, avec captures d'écran facultatives, peuvent être envoyés depuis Réglages > À propos,
  et le journal des modifications peut aussi y être consulté.

- Les messages récents d'une conversation peuvent être retrouvés par leur sens dans le rappel de mémoire
  dès leur enregistrement.

- Les résultats de recherche ne sont réutilisés que tant qu'ils sont encore frais (#7), et une
  recherche de liste de fichiers faisant suite à une recherche de contenu renvoie des noms de fichiers au lieu du
  contenu précédent (#9).

## v1.0.10 - 2026-10-08

- Des fournisseurs d'API personnalisés peuvent être enregistrés dans les Réglages avec des adaptateurs
  de connexion propres à chaque fournisseur.

- Les codes QR de connexion à distance n'apparaissent qu'une fois le relais prêt, et les cartes
  d'appairage périmées sont effacées.

- Les alias de modèles évolutifs d'OpenRouter peuvent être sélectionnés et enregistrés pour Principal et les
  agents. Les derniers alias et les modèles stables ne sont plus masqués à tort
  en raison de l'ancienneté du catalogue, d'aperçus plus récents ou des limites de famille du sélecteur de modèle.

- L'initialisation du patch natif garde son processus actif tant que la vérification est
  en attente, ce qui évite une sortie prématurée lorsque le préchauffage et la vérification se chevauchent.

## v1.0.9 - 2026-10-07

- Les instructions communes et de projet parviennent à chaque nouvelle conversation, même quand
  l'extension Mémoire n'est pas installée ou est désactivée ; cet interrupteur ne
  concerne désormais que les outils de mémoire et de rappel. L'enregistrement d'une instruction n'attend plus
  plusieurs secondes le modèle d'embedding, les instructions sont transmises
  telles quelles, sans identifiants internes, et elles peuvent totaliser jusqu'à 32 Ko.

- La connexion à GitHub depuis les Réglages, ainsi que toute autre fonctionnalité qui lance un
  processus de terminal, fonctionne de nouveau dans l'application de bureau installée au lieu
  d'échouer avec « posix_spawnp failed ». Un compte GitHub supplémentaire obsolète conservé par
  gh ne fait plus indiquer « no account is signed in » après une connexion réussie.

- Browser Use et Computer Use ne demandent plus d'approbation avant leur premier
  appel dans une session, et `setup set_first_use_approval` a disparu.

- La carte d'approbation d'outil s'aligne sur les cartes empilées au-dessus de la saisie : l'icône
  d'avertissement, le titre et l'outil tiennent sur une seule ligne, la raison figure en dessous avec
  uniquement la commande, le chemin ou l'URL approuvés (ni ligne de dossier ni liste d'arguments),
  et Refuser se place discrètement à côté d'Autoriser.

- Les nouveaux modèles récupèrent leurs capacités depuis les catalogues des fournisseurs au lieu
  d'attendre une version : changements d'effort en cours de conversation sur la
  voie ChatGPT, Fast mode et réglages de cache sur la voie de l'API OpenAI, Fast mode sur
  Claude, et effort de raisonnement sur xAI. GPT-6.1 Sol et Claude Sonnet 5.5 sont
  désormais pris en charge, et le bouton Fast n'apparaît plus sur les modèles Claude qui
  ne peuvent pas l'utiliser.

- Claude Sonnet 5.5 affiche de nouveau ses notes entre les appels d'outils, et les modèles
  Claude Fable et Mythos peuvent utiliser la recherche web hébergée.

- La version client attendue par chaque fournisseur est mémorisée d'une exécution à l'autre, de sorte qu'un
  redémarrage ou un démarrage hors ligne ne retombe plus sur une ancienne valeur intégrée.

- Davantage d'erreurs « conversation trop longue » de GLM, Kimi, Qwen, MiniMax, xAI et
  d'autres backends déclenchent désormais le compactage au lieu de mettre fin au tour, et une
  surcharge de Claude survenant en pleine réponse suit les mêmes règles de nouvelle tentative et de repli qu'une
  surcharge au début d'une réponse.

- Les notices et erreurs ne s'empilent plus au-dessus de la saisie : les confirmations de commandes slash
  et les échecs du microphone, des pièces jointes et des commandes apparaissent comme des
  notifications, et la progression du téléchargement vocal ne s'affiche que sur sa carte des Réglages.
  Toutes les erreurs se présentent désormais de la même manière, sans carte encadrée, et les
  téléchargements de modèles locaux affichent une barre de progression pleine largeur sous leur ligne.

## v1.0.8 - 2026-10-05

- L'application macOS est signée avec un certificat Developer ID et notariée par
  Apple : une copie téléchargée s'ouvre donc sans avertissement Gatekeeper et la mise à jour
  automatique de macOS peut installer les nouvelles versions. Les invites du microphone et d'AppleScript
  expliquent désormais à quoi Mixdog les utilise.

## v1.0.7 - 2026-10-04

- Browser Use sur le téléphone diffuse la page du bureau en direct au lieu de
  rafraîchir des instantanés, et accepte les mêmes saisies souris, tactile, molette, clavier et
  IME que le volet du bureau. Lorsqu'un agent passe la main sur la page (par
  exemple un CAPTCHA), le téléphone l'ouvre aussi.

- L'activité des outils dans la transcription est plus facile à parcourir : chaque ligne commence par un
  court verbe, les lectures et recherches affichent des résultats par fichier, les listages affichent des lignes
  de fichiers, les commandes ont leur propre encadré, la sortie de `git diff` s'affiche comme un diff,
  et une page visitée par le navigateur obtient une carte qui la rouvre dans le volet.

- Les notifications de fin de tour arrivent plus vite, affichent du texte brut au lieu de Markdown
  non rendu, se terminent sur une phrase entière et ne sont plus retenues par
  les tâches shell d'arrière-plan de longue durée.

- Les sessions récemment utilisées s'ouvrent plus vite après un redémarrage et lorsqu'on y revient.

- L'outil setup peut gérer les comptes OAuth, les options développeur, les épingles de la barre
  d'activité et le serveur MCP d'un plugin, et les requêtes des sessions en volets scindés sont
  prises en charge. La fenêtre d'effacement automatique propre à un fournisseur remplace désormais la fenêtre globale.

- L'outil Git s'active partout où `git` est installé, sans installer
  d'extension. Les planifications et les webhooks sont toujours livrés à la session de l'application.

- L'interface de l'application reste à l'échelle de 100 %, les réglages enregistrés dans une autre fenêtre ou
  un autre terminal s'appliquent immédiatement, et les bordures, icônes, espacements de liste et
  entrées de boîtes de dialogue sont plus cohérents.

## v1.0.6 - 2026-10-03

- Les notifications push du téléphone restent silencieuses tant que l'application est à l'écran, suivent
  un abonnement que le navigateur renouvelle seul, et l'interrupteur se désactive lorsque
  les notifications sont bloquées dans les réglages système.

- L'application du téléphone ne reste plus sur son écran de chargement à son retour après
  une mise à jour du relais ; elle termine son chargement dès que le bureau se reconnecte, et
  un premier lancement rapide n'omet plus l'installation du service worker de l'application.

- Sur Android, le geste de retour ferme le panneau ou le menu ouvert sans
  faire clignoter la barre de navigation.

- Les onglets d'espace de travail, l'en-tête du panneau latéral et le bouton de nettoyage de Studio sont
  plus compacts, et l'onglet sélectionné ressort plus nettement.

- Les libellés d'utilisation sont plus courts, l'allocation à réinitialiser s'affiche par heure une fois
  qu'il reste moins d'un jour et ne dépasse jamais ce qui reste, et les traductions sont
  peaufinées dans toutes les langues.

## v1.0.5 - 2026-10-03

- L'application de bureau peut déclencher une notification du système, avec un son, lorsqu'un tour
  se termine par sa réponse finale, et la notification ramène à cette
  session.

- Les outils Office produisent des documents docx, xlsx et pdf à partir de HTML via une seule
  session de navigateur partagée.

- L'utilisation affiche des estimations de la valeur des quotas et des totaux par session.

- Les hôtes Browser Use et Computer Use sont plus robustes : transformations de cadres, confidentialité
  visuelle, captures d'écran en tuiles et reprise après échec.

- La vérification de syntaxe PowerShell ne confond plus les fragments verbe-trait d'union dans les
  chemins avec des cmdlets.

- `adm-zip` passe à la version 0.6.1 pour corriger CVE-2026-102282.

## v1.0.4 - 2026-10-01

- Les sélecteurs de modèle se rafraîchissent dès qu'un fournisseur change. Les connexions OAuth
  par navigateur (OpenAI, Grok, Cursor, Antigravity) et les changements de compte
  rechargent désormais le sélecteur immédiatement au lieu d'attendre un redémarrage, et un fournisseur
  connecté, supprimé ou changé dans une fenêtre rafraîchit aussi toutes les autres
  fenêtres de bureau et les téléphones appairés.

- La fermeture de la fenêtre ne demande plus quoi faire. Les Réglages proposent un choix « À la fermeture de la fenêtre »
  entre la réduction dans la zone de notification (par défaut) et
  la fermeture complète, l'icône de la zone de notification est disponible dès le lancement, et
  l'invite de confirmation de fermeture dans l'application a disparu.

- Les lignes d'agents de workflow se lisent partout de la même façon : une ligne sans modèle
  épinglé, y compris Recherche web, affiche « Par défaut », et les noms d'agents et les libellés
  de modèles restent non traduits. Les onglets d'espace de travail non sélectionnés reposent sur une plaque discrète
  au lieu de fins séparateurs.

- L'outil Objectif et la compétence goal-management décrivent les Objectifs comme une liste de tâches
  pour un travail approuvé mené sur plusieurs tours, et excluent les planifications récurrentes et les
  objectifs qui attendent des semaines des événements externes.

## v1.0.3 - 2026-10-01

- La génération de médias enregistre une ligne d'utilisation par tâche d'image ou de vidéo avec les
  jetons, images, secondes et coûts rapportés par le fournisseur, de sorte que les médias Gemini,
  Antigravity, Codex et xAI apparaissent dans les totaux d'utilisation et de coût aux côtés des
  modèles de texte. Les tarifs des médias proviennent du catalogue de prix publié.

- Arrêter et Reprendre de Computer Use se rétablissent proprement après un nettoyage échoué : les
  workers inactifs sont retirés au lieu d'expirer, et un Arrêter ou Reprendre de l'utilisateur
  efface l'ancien état « input not confirmed released ».

- Les sessions en attente de tâches shell d'arrière-plan s'affichent comme en attente plutôt qu'inactives,
  et l'indicateur de tâches shell n'affiche plus les tâches d'un propriétaire précédent ni ne perd
  les mises à jour arrivées pendant une interrogation. Les listes de sessions et d'agents évitent les
  redessins inutiles quand rien n'a changé. Le graphique d'utilisation, les pages de la barre, les onglets d'espace de travail,
  les listes d'extensions et les boîtes de dialogue ont un style rafraîchi.

- Les analyses grep et read identiques et simultanées partagent une seule analyse native, les
  résultats en cache sont invalidés par chemin après des modifications, et un patch annulé s'arrête
  avant d'écrire d'autres fichiers. La recherche du graphe de code fait correspondre les chemins Windows
  sans tenir compte de la casse, des séparateurs, des préfixes verbatim (`\\?\`) et UNC. Un
  hook pré-outil en échec bloque désormais l'outil au lieu de le laisser s'exécuter.

- La compétence browser garde les pages en arrière-plan sauf si la page elle-même
  est le livrable ou si l'utilisateur doit agir dessus. Le développement du bureau
  (`npm run dev`) et les scripts E2E directs Windows s'exécutent dans un profil isolé
  neuf sur le port CDP `9342`.

## v1.0.2 - 2026-10-01

- Les boutons de copie de la transcription peuvent écrire dans le presse-papiers depuis la fenêtre
  de bureau de confiance. Le texte des réponses, les blocs de code, la sortie des outils et les diffs par fichier
  ont une couverture de non-régression pour le texte copié exact, les nouvelles tentatives et le contenu changeant ;
  les lectures du presse-papiers et les autorisations pour d'autres fenêtres restent bloquées.

- Les commandes de modèle et d'effort ouvrent le sélecteur de modèle de la conversation en cours,
  et les agents désactivés conservent le modèle qui leur est sélectionné. Le tutoriel de démarrage
  explique la recommandation du modèle Maintainer, et les diagnostics couvrent désormais
  les fournisseurs locaux, les fonctionnalités intégrées, la voix et les plugins manquants ou invalides.

- Les liens de fichiers Windows gèrent les séparateurs encodés et les chemins contenant des espaces ou du
  texte coréen. Une mention de fichier dont la recherche initiale a échoué peut être cliquée
  pour réessayer. Tout sélectionner dans Studio inclut tous les éléments de l'onglet, et pas seulement
  les pages déjà chargées.

- Computer Use garde les références de capture alignées sur les relectures d'accessibilité,
  relie en toute sécurité les contrôles reconstruits uniquement lorsque leur identité observée correspond,
  et attend tant que le bureau d'entrée est verrouillé au lieu de traiter le verrou comme
  un échec de l'observateur.

- Les onglets d'espace de travail et le tutoriel de démarrage ont un style plus clair, la barre latérale
  des sessions démarre ouverte, et les groupes d'outils n'affichent plus le badge d'échec
  agrégé. Le texte des instructions de projet n'est plus ajouté au bloc d'environnement
  du prompt système. Les paquets publiés excluent les tests de développement imbriqués.

## v1.0.1 - 2026-09-30

- L'application de bureau sous Windows 11 s'affiche désormais dans un cadre de fenêtre Mica avec une interface
  plus calme et monochrome : les fenêtres contextuelles et les panneaux se distinguent par l'ombre plutôt que par des bordures,
  les sélections ne deviennent plus bleues, et l'accent est réservé à l'état en direct. Le texte
  suit une seule échelle typographique (des légendes de 12 px aux titres de page de 20 px et aux chiffres
  clés), l'onglet sélectionné est une carte surélevée, les boutons destructeurs restent
  neutres jusqu'au survol, et les graphiques d'utilisation et de contexte partagent une palette.

- La fermeture de la fenêtre demande une fois s'il faut garder Mixdog actif dans la zone de notification ou
  quitter complètement, et mémorise la réponse. Quitter alors qu'un agent travaille encore
  demande à chaque fois.

- L'utilisation de l'abonnement affiche la part de chaque modèle sous forme d'aire empilée sous la
  courbe du total, et sa carte au survol ne suit le pointeur qu'à l'intérieur du graphique.

- La conversation reste ancrée à son dernier message lorsqu'une carte change
  de hauteur pendant un défilement. Les fichiers SVG écrits par un agent apparaissent comme des résultats d'image
  et s'ouvrent dans la visionneuse du système, et les agents remettent les travaux visuels comme les
  SVG ou les pages HTML sous forme de fichiers enregistrés au lieu d'en coller le source.

## v1.0.0 - 2026-09-30

- La mémoire ne peut plus être mise hors service par une reconstruction du runtime. Un runtime de mémoire
  reconstruit est publié sous une nouvelle étiquette de version au lieu de remplacer les fichiers
  que vérifient les applications installées, un nouveau runtime s'installe à côté de celui en cours d'utilisation
  au lieu de le supprimer pendant que PostgreSQL en dépend encore, et deux
  processus installant en même temps ne suppriment plus le téléchargement l'un de l'autre. Les déploiements
  de développement local refusent de s'exécuter depuis une branche en retard sur son amont.

- Les cartes d'outils ne marquent plus les appels terminés comme échoués. Une commande dont la sortie
  contient une ligne `status:`, un `git diff --quiet` ou `git grep` qui signale une
  différence ou l'absence de correspondance, une recherche code_graph qui ne trouve aucun symbole, et la pagination
  de résultats tidy stockés s'affichent désormais comme terminés ; une commande git qui se termine avec un code non nul
  s'affiche comme une sortie, comme le shell ; et une commande de navigateur ou d'ordinateur arrêtée
  parce que l'utilisateur a repris la main s'affiche comme annulée.

- Moins d'appels d'outils échouent sur une faute d'argument au premier essai : l'outil git ajoute un
  `git` initial manquant, read déclare sa limite de 10 cibles dans son schéma, et
  un Objectif rempli de tâches terminées explique comment faire de la place pour de nouvelles. Les journaux
  d'échec enregistrent désormais les cibles de lecture et la taille totale des lots de chemins.

- Les requêtes sont facturées au palier avec lequel elles ont réellement été envoyées : les requêtes Fast et
  Priority utilisent leurs tarifs publiés, une requête Fast retentée en standard est facturée au tarif
  standard, et les variantes Cursor Fast sont facturées comme leur modèle du catalogue. Activer Fast met à jour
  immédiatement la ligne d'état.

- Les règles de validation des données Excel sont vérifiées avant la création d'un classeur, de sorte qu'un
  type de règle inconnu ou une borne manquante échoue d'emblée sur les deux backends. Le
  reflet d'activité en direct est une bande plus courte et plus pâle, et les noms de résumé d'outil utilisent
  la graisse moyenne.

## v0.9.175 - 2026-09-29

- Les agents Claude conservent désormais le cache de leur conversation pendant 5 minutes au lieu d'une
  heure. Lorsque la requête suivante d'un agent arrive après l'expiration de ce cache —
  après une longue compilation ou un long test, ou lorsqu'un agent terminé est repris — il
  compacte d'abord sa conversation, de sorte que la requête réécrit la conversation compactée
  au lieu de tout ce que l'agent avait accumulé. Dans une relecture de l'usage
  récent des agents Claude, cela a réduit le coût en jetons des agents d'environ un quart. Les sessions
  Lead sont inchangées.

- De nombreuses sessions exécutées en parallèle ne se ralentissent plus mutuellement. Les messages
  en attente sont conservés par session, les résumés de session et l'usage de la passerelle sont
  ajoutés au lieu d'être réécrits, les transcriptions stockées sont analysées hors de la boucle
  principale, et un cycle de mémoire en échec temporise au lieu de réessayer en boucle serrée. Quand le démon se termine, il enregistre pourquoi. L'hôte de sessions
  multi-processus distinct a disparu ; les sessions s'exécutent dans le démon lui-même.

- L'utilisation de l'abonnement enregistrée avant un changement de compte compte désormais pour le
  compte qui était utilisé au début de l'enregistrement. Grok, Claude et Cursor
  signalent leurs versions client actuelles au lieu de versions fixes.

- L'application de bureau n'affiche plus de session vide lorsque le démon livre
  son contenu juste après avoir répondu à la demande d'ouverture. Le script de démarrage de l'application empaquetée
  est autorisé par la politique de sécurité du contenu, et les vérifications de racine de projet,
  les erreurs de répartition du relais et la restauration de session du navigateur sont corrigées.

- Classeurs et documents modifiés sans Office : vider une cellule vide ne
  supprime plus la cellule suivante, la suppression d'un commentaire trouve les commentaires dont
  l'auteur est mis en forme, les parties liées par des chemins absolus se résolvent, et le texte qui
  ressemble à un motif de remplacement est inséré littéralement.

- Les runtimes téléchargés (PostgreSQL, pgvector, polices, FFmpeg) sont vérifiés
  par rapport à des sommes de contrôle figées avant utilisation. Les outils natifs corrigent une
  analyse d'identifiant de fenêtre qui pouvait couper un caractère multi-octet, un calcul de durée qui pouvait
  déborder, et un remplacement d'instantané qui pouvait laisser un fichier partiel.

## v0.9.174 - 2026-09-29

- La boîte de dialogue d'utilisation répond désormais à une seconde question : comment le quota d'un abonnement
  a été consommé. À côté de l'utilisation des jetons, un onglet Utilisation de l'abonnement suit les
  fenêtres de limite propres à chaque fournisseur — Codex, Claude, Grok, Cursor, Antigravity et
  OpenCode Go — à mesure qu'elles montent et se réinitialisent, avec les modèles qui ont fait bouger la jauge
  et l'historique des fenêtres précédentes. Mixdog enregistre chaque relevé de quota
  qu'il mesure ; une hausse sans requête Mixdog derrière elle s'affiche comme une utilisation extérieure à
  Mixdog, par exemple l'application web du fournisseur. Une jauge de fournisseur dans le menu
  d'utilisation ouvre directement son propre abonnement.

- `/doctor` fonctionne aussi dans l'application de bureau, sous forme de boîte de dialogue (également dans Réglages →
  Système → Doctor). Il exécute les mêmes contrôles d'état en lecture seule que la TUI, tous
  à la fois avec un délai par contrôle afin qu'un contrôle bloqué ne puisse pas masquer
  les autres, et chaque avertissement ou échec indique comment le corriger.

- Les nouvelles présentations PowerPoint sont conçues en HTML. Le modèle compose chaque diapositive en
  HTML et CSS, un Chrome ou Edge local l'affiche, et `author` transforme ce que le
  navigateur a dessiné en objets PowerPoint natifs et modifiables : zones de texte qui conservent
  les retours à la ligne du navigateur, formes, lignes, tableaux, graphiques et images.
  Le texte coréen se coupe là où un lecteur l'attend, un contrôle de géométrie refuse les diapositives
  dont les alignements déclarés ne peuvent pas être confirmés par le navigateur, et `render` affiche
  chaque page HTML à côté de son rendu PowerPoint. La voie par script subsiste pour les
  présentations qui veulent les dispositifs mesurés du kit, ou lorsqu'aucun navigateur local n'existe.

- L'insertion ou la suppression de lignes et de colonnes dans un classeur sans Excel
  réécrit désormais tout ce qui désigne ces cellules, comme le fait Excel : formules de
  chaque feuille, noms définis et zones d'impression, mises en forme conditionnelles,
  validations, séries de graphiques, sources de tableaux croisés dynamiques, filtres, liens, fusions, tableaux et
  dessins. Les cellules se déplaçaient alors que leurs références restaient en place, si bien qu'un
  total de rapport continuait à additionner l'ancienne plage et affichait 72 200 là où Excel affichait
  74 700. Une modification dont les références ne peuvent pas être réécrites est refusée, avec
  la liste, avant que quoi que ce soit ne change.

- Les PDF et les bandes de feuilles de calcul composées gardent les dates, heures, fractions et
  montants coréens sur une seule ligne. « 10월 14일 », « 14시 30분 », « 3분의 1 », « 12만 6천 원 » et
  « 24억 원 » ne se coupent plus au milieu, ce qui séparait une date de décision ou
  une économie sur deux lignes.

- Les fichiers Office sont identiques, qu'ils soient produits par Microsoft Office ou par le
  rédacteur portable intégré. Une longue comparaison côte à côte des deux a aligné
  l'espacement, le mode de compatibilité et les tableaux de Word ; l'ajustement automatique, les retraits,
  les bordures, la mise en page d'impression et les graphiques prédéfinis d'Excel ; le retour à la ligne coréen,
  les polices d'Asie de l'Est, les pieds de page, les recadrages de couverture, les ombres et la transparence de PowerPoint ; et l'alignement
  et les largeurs de tableau des PDF. Les contrôles de relecture signalent les mêmes problèmes sur les deux
  backends, les graphiques Excel peuvent lire la plage d'une autre feuille, et `set_chart_data`
  conserve les liens et les noms de séries d'un graphique.

- Computer Use fonctionne sur macOS et Linux. Les versions de bureau pour ces systèmes
  embarquent un backend natif qui parle le protocole de l'hôte Windows et applique
  les mêmes listes d'actions et limites. Une séquence peut aussi désormais agir sur plusieurs
  éléments d'une même observation : chaque étape suivante revérifie son élément par rapport à
  l'arbre d'accessibilité en direct, et la chaîne s'arrête en cas de changement de fenêtre, d'échec, ou d'élément
  désactivé ou hors écran.

- L'application du téléphone s'ouvre et se reconnecte plus vite et transfère bien moins de données. La
  transcription s'affiche juste après la première synchronisation, les courtes reconnexions reprennent
  par deltas au lieu d'une resynchronisation complète, le téléphone ne reflète que l'onglet qu'il affiche,
  la revue de tour repliée lit les noms et nombres de fichiers sans le texte des patchs,
  et les recherches de projet lentes ne retardent plus les autres appels. Une application de téléphone laissée
  ouverte vérifie la présence d'un nouveau déploiement quand elle revient au premier plan,
  et en adopte un hors écran, même en plein tour.

- Le démon utilise moins de mémoire et se bloque moins : les sessions n'enregistrent que ce qui a
  changé, le registre d'utilisation travaille hors du thread principal, les verrous de fichiers et les appels git
  ne le bloquent plus, et les longues transcriptions se paginent par pas de 1 Mo. Le bureau
  et le téléphone affichent le Markdown en flux continu et le défilement tactile avec moins de recalculs de mise en page,
  et la transcription de l'application web ne tremble plus pendant la mesure des lignes.

- La saisie vocale indique qu'elle se prépare jusqu'au début réel de la capture, préchauffe
  la transcription pendant que vous parlez, et transcrit plus vite sans bloquer
  l'application.

- Les résultats d'outils coûtent moins de jetons au modèle. `read` renvoie ses lignes sans
  numéros de ligne — la TUI et le bureau dessinent toujours la gouttière — soit environ 16 %
  de jetons en moins sur les sessions enregistrées ; les notices du shell et des tâches sont plus courtes ; et
  les modifications rapportent des chemins relatifs au répertoire de travail.

- Le compactage emporte moins de matériel périmé dans les grandes fenêtres de contexte. La
  conversation verbatim et l'historique récent des outils conservés lors d'un Compacter sont
  plafonnés à 20 000 jetons au lieu de croître avec la fenêtre. Un instantané de navigateur
  ou une observation de bureau remplacé par une observation plus récente de la même page ou fenêtre
  ne conserve que son résultat et un pointeur vers l'original archivé,
  et les réponses plus anciennes abandonnent leur relecture opaque du fournisseur tout en conservant leurs appels
  d'outils et leurs résultats.

- Un fournisseur brièvement indisponible ne met plus fin au tour dès que
  ses propres nouvelles tentatives sont épuisées. Tant que rien n'est parvenu à l'écran, le tour
  attend encore quelques cycles de récupération, de 15 secondes jusqu'à une minute,
  et suit le Retry-After propre au serveur. Lorsqu'un flux est coupé alors que les arguments d'un appel
  d'outil arrivent encore, cet appel n'est pas exécuté, et le modèle
  est invité à répartir le contenu sur des appels plus petits au lieu de le renvoyer
  en entier.

- OAuth Cursor et Antigravity (Gemini) sont des interrupteurs distincts sous Réglages →
  Développeur, et chacun ne s'active qu'après confirmation du risque de restrictions de compte
  qu'implique l'usage de ce fournisseur via OAuth. La variable d'environnement
  `MIXDOG_DEV_PROVIDERS` ne les active plus.

- La conversation ne saute plus quand les barres au-dessus du compositeur s'ouvrent ou
  se ferment : elles glissent par-dessus le contenu au lieu de décaler la transcription de
  toute leur hauteur d'un coup, et l'ouverture d'une session n'affiche plus brièvement un compteur de revue de tour
  qui disparaît un instant plus tard.

- Renommer un fichier ou un dossier dans l'explorateur conserve ses onglets d'éditeur ouverts sur
  le nouveau chemin. Un fichier comportant des modifications non enregistrées est refusé tant qu'il n'est pas enregistré, puisque son
  tampon appartient à l'ancien chemin.

- Studio nettoie en masse : les éléments sélectionnés, tout ce qui précède une date,
  les entrées dont les fichiers ont disparu, ou tout un type. Réglages → À propos affiche une
  adresse de support avec des boutons Copier et E-mail, et la boîte de dialogue Effacer les données de navigation du
  navigateur intégré a été supprimée.

- Un tour d'objectif automatique qui n'appelle aucun outil attend désormais au lieu de relancer
  une invite.

## v0.9.173 - 2026-09-22

- Un message en file d'attente restauré conserve le texte confirmé par le démon. Restaurer un message
  publie deux fois d'affilée — d'abord l'estimation locale, puis la réponse du démon
  un instant plus tard — et les deux étaient estampillées avec l'horloge. Lorsqu'elles
  tombaient dans la même milliseconde, l'invite traitait la seconde comme la première et
  gardait l'estimation, si bien qu'un message modifié pouvait revenir subtilement faux. L'invite
  suit désormais le texte lui-même, et pas seulement l'estampille.

- Sauter deux fois en un instant ne perd plus le second saut. Deux demandes « aller à cette
  ligne » dans la même milliseconde portaient la même estampille, et l'éditeur ne lisait que
  l'estampille, de sorte que la seconde était ignorée et le curseur restait
  sur la première ligne.

- Une recherche qui plante n'emporte plus tout le moteur de recherche avec elle. Le
  moteur savait déjà répondre à une mauvaise requête par une erreur et continuer à
  servir, mais la version livrée était compilée de sorte que tout plantage tuait le
  processus — perdant toutes les autres recherches en cours et l'index de fichiers à chaud. Il
  survit désormais, répond à cette seule requête par une erreur, et conserve
  ses caches. Si un plantage survient pendant la collecte des fichiers, les
  chemins collectés sont tout de même publiés au lieu de disparaître discrètement de
  la réponse.

- Appliquer et Supprimer sur une ligne de fournisseur local sont sur la même ligne. Ils différaient
  de deux pixels parce que la ligne mélangeait un champ plus haut avec un bouton plus court.

- Le nettoyage du code vous avertit quand un outil n'est pas celui que vous croyez. Si un
  formateur ou un linter du même nom est accessible sur votre machine mais n'est
  pas celui que Mixdog exécute, le rapport nomme désormais les deux, avec leurs versions —
  exécuter cet autre binaire ne dit rien du résultat qui vous a été présenté. Une exécution de nettoyage
  sépare aussi les constats dans les fichiers que vous avez déjà touchés des constats dans
  des fichiers non touchés du dépôt, de sorte qu'appliquer les corrections à un dossier entier ne
  réécrit plus des fichiers que vous ne vouliez pas modifier.

- La mise à jour de votre application installée ne s'arrête plus parce que votre antivirus a supprimé un
  fichier que la mise à jour écarte de toute façon. La préparation dépaquetait toute l'application installée et
  supprimait la partie qu'elle allait remplacer ; un seul fichier du moteur de rendu mis en quarantaine
  suffisait à interrompre le déploiement.

## v0.9.172 - 2026-09-21

- Une page ne s'ouvre plus en annonçant des téléchargements qu'elle n'a jamais effectués. Les fichiers enregistrés
  appartiennent à la session, mais chaque page suivait ce qu'elle avait signalé en
  partant de zéro, si bien que chaque page ouverte ensuite accueillait l'appelant avec tout l'arriéré
  — une page de recherche signalant un fichier qu'un autre onglet avait enregistré quelques minutes
  plus tôt. Une nouvelle page démarre en connaissant déjà ce qui s'est passé avant son existence ;
  un fichier enregistré pendant qu'elle est ouverte lui parvient toujours.

- Les défauts propres au navigateur ne passent plus pour ceux de la page. Un appel CDP expiré,
  un cadre enfant qui n'a pas pu être attaché, une interception à laquelle il n'a pas été possible de répondre — tous étaient
  consignés comme erreurs de console de la page, si bien qu'une réponse sur un site sain pouvait
  s'ouvrir sur `CDP Runtime.evaluate timed out` comme si le site
  l'avait consigné. Ils restent lisibles via `console`, marqués `[browser]`, et
  ne comptent plus parmi les erreurs dont une page est responsable.

- Un délai atteint derrière une boîte de dialogue ouverte le dit. Un alert, confirm ou prompt
  gèle le thread principal de la page, si bien que l'appel suivant mourait sur son délai
  sans rien d'autre que l'échéance — et la nouvelle tentative évidente expirait de la même façon. L'erreur
  nomme désormais la boîte de dialogue et son texte, et indique d'y répondre avec
  `handle_dialog` avant d'agir de nouveau sur la page.

- Un changement de route côté client reçoit pour réponse l'écran qu'il a produit, et non celui
  que l'appelant a quitté. Les applications monopages déplacent l'adresse avec `history.pushState`
  et affichent la nouvelle vue un instant plus tard ; aucun document ne se charge, donc la stabilisation voyait
  une page calme et revenait aussitôt — et un `expect.url` était satisfait par la nouvelle
  adresse avant que quoi que ce soit ne soit dessiné. Cliquer sur « Learn » sur react.dev répondait avec
  la page d'accueil sous l'adresse `/learn`. Lorsqu'une action change l'adresse
  sans chargement, la réponse attend désormais que la page se calme et une condition
  d'URL ne peut plus écourter cette attente. Mesuré sur le banc d'essai sur appareil réel :
  les latences de navigate, click et snapshot sont inchangées, car seuls les changements de route dans le même
  document subissent l'attente supplémentaire.

- Le détail d'un WebSocket montre la requête d'upgrade réellement envoyée. Seules l'adresse
  et la réponse de la poignée de main étaient enregistrées, si bien que `network` répondait par une section
  d'en-têtes de requête vide — alors qu'un upgrade refusé s'explique généralement
  par `Origin`, `Sec-WebSocket-Protocol` ou un cookie. Les identifiants restent masqués.

- Un clic qui ouvre un onglet n'est plus signalé comme un clic sans effet.
  Un lien `target="_blank"` laisse le document courant intact, si bien que la réponse
  indiquait « No observable change » et invitait l'appelant à chercher un élément
  masquant — alors que la page qu'il venait d'ouvrir figurait dans `list_tabs` sans être mentionnée.
  La réponse nomme désormais la page ouverte et la façon d'agir dessus.

- `drag` accepte des cibles sans instantané comme toutes les autres actions de pointeur. Ses deux
  extrémités n'acceptaient que des refs ou des coordonnées brutes, et les éléments qu'une page rend
  déplaçables — cartes, lignes de liste, zones de dépôt — n'ont souvent aucun nom accessible et
  donc aucune ref, de sorte que déplacer l'un d'eux exigeait d'abord de s'appuyer sur un instantané visuel même
  quand le sélecteur CSS était connu. `target` et `dropTarget` désignent désormais les deux
  extrémités, résolues ensemble en une seule observation ; les refs et coordonnées fonctionnent
  comme avant, et les deux extrémités doivent toujours être adressées de la même façon.

- Un fichier enregistré n'est plus annoncé comme une requête échouée. Une adresse qui
  se transforme en téléchargement annule sa propre navigation, et Chromium signale cette
  annulation sous la forme `net::ERR_ABORTED`, si bien qu'une réponse qui listait le téléchargement
  le listait aussi comme un échec réseau récent. Les requêtes annulées — téléchargements, fetches
  abandonnés par la page, navigations remplacées par une autre — restent lisibles via
  `network` mais ne sont plus avancées d'office comme des fautes de la page ; une requête qui a
  réellement échoué l'est toujours.

- Une réponse `brief` ne transforme plus un seul champ rempli en changement sur toute la page.
  Elle compare avec la précédente observation de l'appelant, et lorsque cette observation
  était plafonnée ou filtrée, elle n'avait jamais rapporté le reste de la page — si bien que chaque
  élément extérieur à elle était listé comme « changed or new ». Remplir trois cases d'un
  formulaire répondait par quinze éléments, et taper un mot de recherche répondait par cent quarante-six.
  La réponse distingue désormais ce que l'action a manifestement changé de
  ce que l'observation précédente n'avait simplement pas couvert, et indique
  quelle part de la page cette observation contenait. Rien n'est omis dans les deux cas.

- Les en-têtes de requête dans `network` sont ceux qui ont réellement été envoyés. Chromium
  signale d'abord un jeu provisoire puis ajoute la langue, l'encodage, les indications client et
  les cookies ensuite, si bien que le détail d'une requête pouvait montrer deux en-têtes et laisser croire
  que la page n'avait jamais demandé de contenu coréen. Le jeu ultérieur est fusionné ;
  les identifiants sont toujours nommés et jamais affichés. Les noms d'en-têtes ne sont pas sensibles à la casse
  et les deux rapports les écrivent différemment, donc la fusion conserve une seule entrée par
  en-tête — l'orthographe et la valeur qui sont passées sur le réseau — au lieu de lister
  `User-Agent` et `user-agent` comme si la requête portait les deux.

- Les sites voient Browser Use comme la version de Chrome qui les affiche. La chaîne d'agent
  portait encore la version de l'application de bureau et le runtime Electron, alors que les
  indications client reçues par les mêmes pages ne nommaient que Chromium ; GitHub répondait
  à cette contradiction par un mur de connexion sur un dépôt public. La partition du navigateur
  présente désormais la chaîne Chrome simple — une empreinte de moins, et
  moins de détours « navigateur non pris en charge » — et un agent utilisateur émulé l'emporte toujours
  lorsqu'une tâche en demande un.

- Les pages qui attachent sans cesse des cadres peuvent de nouveau être observées. Les portails et les pages d'accueil de journaux
  ouvrent des emplacements publicitaires et des widgets par rafales, et un instantané commencé
  au milieu d'une rafale abandonnait avec « frame topology changed during observation » —
  de façon reproductible, au premier et au second essai. Les observations n'ont aucun effet de bord,
  donc le collecteur attend désormais brièvement que la rafale se calme et relit,
  jusqu'à un petit plafond, au lieu de renvoyer une erreur à l'appelant pour une page
  simplement occupée. Quand une lecture échoue encore, la réponse indique désormais que la page est
  chargée et que seule sa lecture a échoué, de sorte que l'étape suivante est d'observer
  de nouveau plutôt que d'abandonner une page qui va bien.

- Une page ne signale que ses propres échecs. Les requêtes et erreurs de console du
  document précédent restaient dans les registres, si bien qu'un instantané d'une page saine pouvait
  lister des requêtes abandonnées du site visité avant elle, et `console` sur une
  page propre pouvait répondre avec les erreurs de la page précédente — deux cas envoyant
  le lecteur à la recherche d'une faute qui n'existait pas. Le chargement d'un nouveau document les efface ;
  naviguer dans le même document les conserve, car rien n'a été rechargé.

- Les courses d'affichage de Browser Use ne sont plus des échecs. Une capture qui perd face à
  une navigation ou à un redimensionnement de fenêtre répond désormais par un marqueur de rééchantillonnage au lieu d'
  une erreur, car le volet allait de toute façon redemander ce
  que la page affiche ensuite. La navigation ordinaire remplissait le journal de l'application d'échecs de
  capture — dix-sept dans une exécution du banc d'essai, aucun désormais — et un téléphone appairé
  signalait la même course comme « could not connect to browser screen » ; il
  rééchantillonne maintenant à la cadence active et ne signale qu'un affichage qui
  cesse réellement de progresser.

- Effacer les données de navigation de Browser Use. Le volet du navigateur a un bouton gomme qui
  supprime le cache, les données stockées par les sites sur cet appareil et les cookies, chacun
  comme une décision distincte : le cache est présélectionné parce que le perdre ne coûte qu'un rechargement
  plus lent, alors que les cookies vous déconnectent de tous les sites et ne sont jamais le choix par défaut.
  Chaque périmètre est effacé séparément, de sorte qu'un échec est signalé comme un échec
  au lieu de disparaître derrière les périmètres qui ont fonctionné. Effacer les cookies réécrit aussi
  le fichier scellé qui transporte les connexions de session d'un redémarrage à l'autre, de sorte qu'une
  connexion effacée ne revient pas à la prochaine ouverture de l'application — et si
  ce fichier ne peut pas être réécrit, les cookies sont signalés comme non effacés plutôt que
  comme effacés. Jusqu'ici la partition partagée grossissait sur le disque sans aucun moyen
  de récupérer l'espace.

- Les métriques `performance` de Browser Use rapportent la mémoire du processus qui peint
  la page, et pas seulement le tas JavaScript : une page dont les images et les calques occupent
  la mémoire semblait auparavant petite. Le relevé nomme le processus, puisqu'un seul
  moteur de rendu peut peindre plusieurs pages du même site.

- La politique de domaines de Browser Use couvre les connexions pair à pair. Lorsqu'un opérateur
  restreint les domaines qu'une page peut atteindre, WebRTC ne contourne plus le
  filtre via STUN et TURN : les connexions pair à pair sont refusées dans la page et
  dans chaque cadre enfant. Sans politique de domaines rien ne change, et cela
  reste un confinement du code de la page et non une frontière réseau.

- Captures d'écran d'éléments dans Browser Use. `snapshot mode=visual` accepte `ref` ou
  `target` et renvoie cet élément comme image à part entière. Le cadre est mesuré en
  pixels CSS du document supérieur — les cadres du même processus intègrent leur décalage côté
  page, un cadre inter-origine ajoute le décalage de sa session sans le test de
  collision qui protège la saisie, car une image n'envoie rien et un cadre
  sous transformation CSS en mérite quand même une — et le recadrage est mis à l'échelle par le
  rapport image/fenêtre d'affichage, de sorte qu'il tient
  sur un affichage zoomé ou haute densité. Un élément plus haut ou plus large que la fenêtre
  est découpé dans la capture du document au lieu de la fenêtre d'affichage, de sorte qu'un long tableau
  ou article arrive entier au lieu de s'arrêter au pli ; seule une page trop
  grande pour être capturée se rabat sur la partie visible, et le signale. L'image est
  réservée à l'inspection : elle n'est jamais liée comme ancrage de coordonnées, car la ref
  reste le moyen d'agir sur l'élément. `mode=semantic`, `fullPage` et
  `format=pdf` refusent une cible au lieu de l'ignorer.

- Fidélité de saisie de Browser Use. `drag` mène désormais à terme le glisser-déposer HTML5 propre à une page :
  l'interception du glisser par Chromium transmet la charge utile que la page a démarrée et
  le geste se termine par `dragEnter`/`dragOver`/`drop`, ce qu'écoutent réellement une
  carte kanban, une liste triable ou une zone de dépôt de fichiers ;
  les pages qui ne suivent que les événements souris gardent l'ancien chemin. `type` envoie un
  véritable événement de touche par caractère au lieu d'insérer toute la chaîne, de sorte que
  l'autocomplétion pilotée par frappe et les listes combinées réagissent, tandis que les caractères
  hors de la disposition US (coréen, emoji) sont toujours insérés comme texte. `press`
  envoie les codes de touches US pour la ponctuation (`.` valait Suppr, `-` valait Inser),
  empêche un raccourci de taper un caractère, et ne déduit plus Maj d'une
  lettre majuscule, ce qui avait transformé `Control+A` en `Control+Shift+A`.
  `upload` dépose des fichiers sur un élément qui n'ouvre jamais de sélecteur de fichiers, avec une
  protection qui neutralise un dépôt non géré — sinon le navigateur navigue
  la page vers le fichier déposé — et signale clairement quand rien ne l'a accepté.

- Fidélité d'observation de Browser Use. `scroll text=` cherche dans les cadres et les racines
  shadow comme `read` et `expect`, choisit une correspondance parmi eux, et ne
  défile plus vers un élément replié. `expect.text` normalise les espaces
  au sein d'une ligne mais conserve les sauts de ligne, de sorte que le balisage indenté correspond tandis que deux
  blocs distincts ne fusionnent jamais en une seule phrase. Les diagnostics de console conservent
  ce qu'une page a consigné : les arguments objet arrivent sous forme d'aperçu lisible au lieu
  d'un message vide, les entrées nomment le script et la ligne qu'un lecteur
  ouvrirait, et un `throw` nu non capturé porte sa position. Les instantanés marquent
  `aria-hidden`, un `select` natif en échec liste les options qu'il a trouvées, et
  `aria-labelledby` se résout à l'intérieur d'une racine shadow.

- Browser Use compte les diagnostics qu'il n'a pas pu faire tenir. Un rapport de page affiche les
  trois erreurs de console et échecs réseau les plus récents, qui passaient pour toute l'histoire :
  douze échecs arrivaient comme trois. Le rapport nomme désormais le total et
  renvoie vers `console` ou `network` chaque fois que la liste est plafonnée.

- Browser Use reconnaît qu'un extrait de page s'arrête trop tôt. Le texte visible d'un
  instantané est plafonné, et le rapport disait seulement « condensed », si bien qu'un long article
  se lisait comme si l'extrait était toute la page. Les deux chemins d'instantané — la capture d'accessibilité
  et le repli DOM — marquent désormais un extrait tronqué, et le rapport indique la quantité qu'il porte
  et précise que la page en contient davantage.

- Les pièces jointes rapportent la taille de l'image qu'elles ont réellement produite. Ajuster une
  image à un budget de patchs de vision rogne les bords un par un, ce qui peut demander
  une boîte que l'image ne remplit pas ; le rendu sortait alors plus petit
  que la taille rapportée à côté, et les coordonnées mappées via cette taille
  étaient décalées. Le redimensionnement rapporte désormais les dimensions de l'image produite.

- Browser Use indique où un script de page a échoué. `evaluate` ne gardait que la première
  ligne de l'erreur du navigateur, si bien qu'un script de plusieurs lignes signalait
  `TypeError: ...` sans rien pour le localiser. L'échec porte désormais
  le cadre de pile le plus interne, et le banc d'intégration fige la position
  que signale un throw sur une ligne ultérieure.

- Browser Use nomme un PDF au lieu de signaler une page vide. L'ouverture d'un lien
  vers un PDF validait l'adresse, mais l'invité n'a pas de visionneuse pour cela, donc
  l'instantané montrait une page sans titre ni texte avec du bruit de console sur une feuille de style
  de visionneuse bloquée — rien qui dise ce qui s'était passé. Le rapport de page
  indique désormais que le document est un PDF que ce navigateur ne peut pas afficher et que
  le fichier doit être lu depuis son URL, et les échecs que les composants intégrés de Chromium
  lèvent pour leurs ressources `chrome-extension://` n'apparaissent plus
  comme des erreurs de console ou réseau de la page. Le banc d'intégration
  couvre la navigation, le rapport silencieux et un instantané ultérieur de la page.

- Browser Use cesse de renvoyer `close_tab` à l'onglet visible. `list_tabs`
  affiche la page visible avec un identifiant de page ordinaire, si bien que viser `close_tab` dessus
  recevait la réponse `unknown background tab "p12"; call list_tabs` — le
  listage qui avait fourni l'identifiant. Le refus indique désormais que la page appartient au
  panneau du navigateur et suggère de la faire naviguer ailleurs ou `hide`, et
  les noms sans rapport signalent toujours un onglet d'arrière-plan inconnu.

- Browser Use indique ce qu'une confirmation de départ a réellement fait. Une page qui protège
  un travail non enregistré arrêtait une navigation par une boîte `beforeunload`, et la
  réponse demandait `handle_dialog` — mais Chromium répond lui-même à cette confirmation,
  si bien que l'appel revenait toujours « no JavaScript dialog is currently
  open » alors que répéter la navigation répétait la même instruction. La
  réponse indique désormais que la navigation a été abandonnée et que la page est restée,
  qu'il n'y a plus rien à répondre, et que le travail contenu dans la page doit être
  terminé ou abandonné d'abord ; le banc d'intégration couvre toute la séquence,
  y compris la navigation qui aboutit une fois la protection levée.

- L'émulation de langue de Browser Use atteint le serveur. `emulate locale` ne réglait que
  `navigator.language`, si bien que la page continuait à demander l'ancienne langue et
  les sites négociaient un contenu que l'émulation contredisait ; elle transmet désormais la
  langue aussi comme `Accept-Language`, et l'effacer rétablit la négociation propre du navigateur.

## v0.9.171 - 2026-09-18

- Reprise de publication : l'artefact du relais de production préparé est identifié par l'exécution
  seule (`production-relay-<run_id>`) et est téléversé avec `overwrite: true`. Le
  nom portait la tentative d'exécution, mais une réexécution partielle conserve le job réussi
  `stage-production-web-relay` tout en réexécutant
  `deploy-production-web-relay` comme dépendant du job en échec, si bien que l'artefact
  propre à la tentative n'existait jamais et que le déploiement mourait sur « Artifact not
  found » avant d'atteindre la production. C'est exactement ainsi que la v0.9.170
  a publié sa version GitHub et son paquet npm sans déployer le relais
  web. `overwrite: true` évite qu'une réexécution complète, où le job de préparation
  s'exécute de nouveau, n'entre en collision avec l'artefact de la tentative précédente, et la porte
  de publication vérifie à la fois le nom et l'écrasement.

## v0.9.170 - 2026-09-17

- Consolidation du prompt système. Chaque règle a désormais un seul propriétaire : la couche
  partagée (`rules/shared/*.md`) ne contient que la politique des outils et s'ouvre sur
  `# Tool Calls` (regroupement d'abord ; `05-parallel-calls.md`), le rôle Lead tient
  en un seul fichier (`rules/lead/LEAD.md` : communication avec l'utilisateur, briefing des agents et
  notifications de fin derrière `<!-- tools: agent -->`, ton), et le contrat
  commun des agents tient en un seul fichier (`rules/agent/AGENT.md` : chaîne de
  commandement, pas d'auto-vérification, anglais, forme de la remise). `00-general.md`,
  `02-persona.md`, `lead-brief.md`, `00-core.md`, `00-common.md` et
  `75-goal.md` ont disparu — leurs phrases survivantes ont été déplacées vers le fichier qui
  en est propriétaire, et les phrases qu'une description d'outil énonce déjà (`load_tool`,
  `Skill`, `goal`, l'approbation de `memory`, `task wait`, le plan de `code_graph`, la
  forme d'appel de read, le routage Git, le routage browser/computer) ne sont énoncées que
  là. La priorité dépend du rôle : la dernière demande explicite de l'utilisateur pour Lead,
  le dernier briefing de Lead pour les agents. La règle de préambule de Lead porte désormais
  sa raison (l'utilisateur ne voit que votre texte) et demande une ligne, pas un nombre
  de mots ; la règle de briefing précise qu'un agent ne voit jamais la conversation, que
  les constats sont synthétisés en chemins, lignes et modification exacte (jamais « sur
  la base de vos constats »), et que le résultat d'un agent n'est jamais prédit.
  Les règles sur les actions destructrices, qui étaient réparties sur quatre sections, tiennent dans une seule
  section `# Destructive Actions`. Les fichiers de rôle (`agents/*/AGENT.md`) abandonnent les
  phrases sur les blocages et la remise que possède le contrat ; `maintainer` gagne un frontmatter
  de nom et de description. Styles de sortie : le titre `## Depth` remplace
  `## Depth Variation`, et la formulation des rapports d'avancement vit uniquement dans les règles de Lead.
  Le workflow Default ne porte plus le paragraphe de repli du relecteur ;
  il accompagne le bloc du mode d'orchestration que les modes de délégation
  injectent. Descriptions d'outils : `edit` ne renvoie plus vers `apply_patch`
  sur les surfaces qui l'ont filtré, `shell` indique que Git passe par `git` uniquement quand
  cet outil est présent, `read`/`grep` abandonnent les plafonds d'octets que le runtime signale
  de toute façon, `code_graph` indique que `symbols` est le plan. Les fournisseurs qui
  livrent eux-mêmes le rappel de tour (`anthropic-oauth` sous forme de message système limité au tour,
  `cursor` via son relais) déclarent `deliversRoundReminder`
  pour que le canal du runtime reste silencieux — les sessions Cursor ne reçoivent plus
  deux fois par tour le rappel de regroupement. La vérification de provenance de l'incitation au regroupement
  normalise les séparateurs de chemin et accepte un répertoire affiché comme préfixe d'un
  chemin plus profond dans le résultat précédent, de sorte qu'un appel de suivi sur un chemin que le dernier
  résultat a révélé ne passe plus pour un appel isolé sans rapport (deux
  faux positifs par session auparavant). Le schéma de route `setup` indique
  `contextPercent` comme entier borné (l'exécuteur exige toujours un
  multiple de 10), de sorte que Gemini ne reçoit plus un substitut d'énumération
  non représentable. Les attentes de tests périmées laissées par le commit de regroupement
  sont mises à jour, et deux tests dépendant du temps ou de l'environnement sont rendus
  déterministes. La compétence de projet `gamerscroll-article` est limitée à
  son projet.
- Les versions GitHub portent désormais la section CHANGELOG.md de la version comme
  notes, suivie du lien de comparaison ; le brouillon s'appuyait auparavant sur les notes
  générées par GitHub, qui ne listent que les PR fusionnées et laissaient la page
  avec un simple lien `Full Changelog` parce que Deploy valide directement sur main.
- Regroupement des outils : après trois cycles d'appels d'outils consécutifs comportant un appel unique d'un même outil dont les
  appels n'avaient pas besoin les uns des autres (aucun argument tiré du résultat précédent,
  aucune étape ordonnée après une mutation ; un autre outil relance la série,
  donc read → shell → apply_patch n'est jamais signalé ; les attentes de tâches, Computer Use,
  les étapes de navigateur et les chargements de schémas/compétences ne comptent jamais), ou un
  cycle d'appels du même outil qui ne diffèrent que par un champ tableau,
  le runtime ajoute un court `<system-reminder>` nommant les arguments tableau
  de la surface d'outils de la session ; il se répète chaque fois que le motif revient et seul un cycle regroupé
  l'efface (tracé comme `batching_nudge`). Un `read` d'un seul fichier juste après
  un cycle grep/code_graph/glob/find qui a localisé plusieurs fichiers reçoit
  l'ensemble localisé sous la forme qu'accepte un seul appel `read`
  (`[{file_path, offset, limit}, …]` ; un read par fichier dans la même réponse
  pour les fournisseurs dont le schéma de read n'accepte que des chaînes de chemin), tracé comme
  `located_sites` : une session Gemini 3.8 Flash enregistrée a localisé des fichiers avec
  grep 13 fois et les a pourtant lus une fenêtre à la fois (63 lectures, 20 des
  28 fichiers lus deux fois ou plus). Les descriptions de `read` et `grep` disent désormais
  ce qu'est le lot — tous les fichiers et plages que vous allez toucher, avant de modifier,
  en un seul appel — et le pied de page des lectures fenêtrées demande une seule lecture plus large au lieu de
  la fenêtre suivante. Les règles partagées énoncent désormais une seule fois l'ordre de travail
  sur les fichiers (`# Tool Calls` : énumérer seulement si le périmètre est inconnu → localiser
  tous les sites → un seul cycle de lecture de fenêtres `{file_path, offset, limit}`, ≤10 par
  appel → toutes les modifications dans une réponse → une vérification) et suppriment les
  phrases qui en disaient des parties à trois endroits ; les descriptions de `read`,
  `grep`, `edit`, `apply_patch` et `code_graph` se réduisent à ce
  contrat (code_graph passe d'environ 150 à environ 90 mots), et le marqueur de plafond intelligent
  d'une lecture fenêtrée nomme la forme à fenêtres localisées ; une autre passe supprime
  la prose de paramètres qui répétait les règles ou des détails internes (`Skill`,
  `find`, `cwd`, `git`, `code_graph.mode`, `grep.path`/`text`,
  `include_noise`, l'aide-mémoire PowerShell et `timeout_ms` de shell) — la surface
  d'outils de Lead passe de 13,4 Ko à 12,7 Ko. Des exécutions GPT-5.6 de huit tâches avant
  et après restent à 8/8 avec la même enveloppe de cycles d'appels, de temps et de coût ;
  la seule régression trouvée en chemin (un cycle de sauvegarde pour les entrées en lecture seule et
  les relevés `git log` après la suppression de deux clauses de garde) est corrigée. La
  règle de sauvegarde indique désormais où va la copie — dans la même réponse que la première inspection,
  jamais dans un cycle à part — car « inside the first inspection
  call » faisait ouvrir à GPT-5.6 2,8 cycles de sauvegarde seule par exécution de huit tâches quand la
  première inspection était un appel `read` ou `git` ; avec la formulation corrigée, il
  n'en a ouvert aucun et a regroupé chaque sauvegarde avec cette inspection. Le rappel
  sériel ne traite plus un tableau dans un appel unique comme un lot : une
  revue Gemini 3.8 Flash enregistrée a exécuté quinze cycles d'un seul appel, en alternant des
  appels `git` d'une et de deux commandes, sans jamais le mériter parce que chaque cycle
  à argument tableau réinitialisait la série. La vérification de provenance se souvient aussi de six cycles
  au lieu de deux, de sorte qu'une liste de fichiers issue de `git diff --name-only` parcourue un élément
  par cycle ne fait plus passer chaque élément pour quelque chose que le diff précédent
  avait révélé. Deux autres rappels du runtime :
  `late_locating` (une recherche après une lecture qui n'en a rien tiré) et
  `located_sites` remettant une fenêtre par site localisé —
  lignes `(Lstart-end)` de code_graph comprises — réparties en plusieurs appels read
  au-delà de dix. Les fichiers de politique de route
  (`rules/routes/*.md`) déclarent aussi désormais un `turn-reminder:` d'une ligne (lu
  une fois dans le bloc `<system-reminder>` final du tour utilisateur, avant la première
  réponse du tour) et un `round-reminder:` d'une ligne à côté de leurs
  règles statiques ; la boucle d'agent résout ce dernier par fournisseur/modèle et il
  parvient au modèle après chaque tour d'outils — sous forme de message système limité au tour d'Anthropic
  (`clear_at: next_user_message`) sur `anthropic-oauth`, le
  motif que documente Anthropic pour Claude Fable 5.1, ou sous forme de
  `<system-reminder>` du runtime après les tours à appel unique ailleurs (`per_round`). Le
  rappel de Fable 5.1 passe d'une constante de fournisseur codée en dur aux
  fichiers de route ; les historiques enregistrés sous la phrase précédente la rejouent
  octet pour octet. Un seul fichier, `routes/common.md`, porte les rappels
  de regroupement de toutes les routes (un fichier sans restriction sert de base ; un fichier nommant
  `models:` ou `providers:` s'ajoute à cette ligne pour ses routes au lieu de
  la remplacer) —
  Gemini passe à un appel par tour une fois les résultats d'outils arrivés, Grok
  regroupe les appels mais n'utilisait jamais d'arguments tableau : ses schémas d'outils aplatis
  ne gardaient que la branche scalaire de chaque champ un-ou-plusieurs
  (`read.file_path`, `grep.pattern`, `git.command`, …). L'aplatissement de Grok
  conserve désormais la branche tableau de ces champs (une valeur voyage comme un
  tableau à un élément) et le dit dans la description du champ, de sorte que le contrat
  de regroupement tient aussi chez ce fournisseur. Les règles partagées gagnent une
  section `# Parallel Tool Calls` qui énonce clairement le contrat (des sessions
  Gemini 3.8 Flash enregistrées émettaient un appel par tour dans 105 tours sur 105 ;
  avec la section en place, une exécution sans interface a regroupé quatre fichiers et git dans
  une seule réponse). Les règles liées à un fournisseur ou un modèle se chargent depuis `rules/routes/*.md`
  via le frontmatter `providers:` / `models:` et s'affichent après les règles
  partagées dans BP1.
  `MIXDOG_ANTIGRAVITY_DUMP_DIR=<dir>` écrit chaque corps de requête Antigravity
  (contenus, outils, configuration ; jamais les en-têtes ni les jetons) pour inspecter le protocole,
  l'équivalent Gemini de `MIXDOG_OAI_WS_DUMP_DIR` ; `mixdog exec` transmet aussi
  `MIXDOG_XAI_CACHE_TRACE` et `MIXDOG_XAI_RESPONSES_CACHE_SCOPE`
  pour les sondes de cache xAI.
- Les requêtes xAI Responses n'envoient plus par défaut de `prompt_cache_key` par session
  (`MIXDOG_XAI_RESPONSES_CACHE_SCOPE` vaut désormais `none` par défaut, le corps littéral de Grok
  Build) : la clé de session scindait le cache du service en voies et
  mesurait deux tours à froid par exécution contre un seul, et aucune réutilisation de préfixe entre
  sessions. `session` et `prefix` restent sélectionnables.
  `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED` remplace le mode d'appel
  de fonctions d'Antigravity pour les essais A/B, et
  `benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs` rapporte les taux
  d'appels multiples et d'arguments tableau par modèle à partir de `agent-trace.jsonl`.
- `mixdog exec` lie le compte OAuth sélectionné dans le pool de comptes de fournisseurs
  de l'hôte (l'identifiant que la connexion écrit aujourd'hui), avec repli sur le
  fichier d'identifiants hérité unique ; auparavant seul le fichier hérité ou un
  `*_CREDENTIALS_PATH` explicite était accepté, si bien que les hôtes à pool seul échouaient avec
  « credentials are unavailable ». `mixdog exec` ne reste également plus 2 à 4 minutes
  après sa réponse avant d'émettre `result` : la suppression de la racine vierge réessayait
  sous Windows pendant tout le budget rmSync (50 tentatives linéaires ≈ 128 s, deux fois quand
  le chemin du postmaster la relançait) alors que le handle SQLite du registre d'utilisation et le `pg.log` d'un
  démon mémoire en cours d'arrêt étaient encore ouverts. Le registre est fermé
  avant la suppression et exec passe un budget de 10 tentatives (≈5,5 s)
  (`cleanup({ rootRemovalRetries })`) ; une racine traînante est laissée au
  balayage périodique des orphelins au lieu de l'appelant.

## v0.9.169 - 2026-09-16

- Code Tidy : Installer télécharge désormais les moteurs principaux (Biome, ruff, shfmt,
  shellcheck, PSScriptAnalyzer) avec progression, et la carte intégrée liste
  chaque moteur avec sa version, son langage, sa source et sa taille ; les moteurs récupérés
  plus tard par un projet apparaissent dans la même liste. Les moteurs manquants au moment du nettoyage
  se téléchargent automatiquement par défaut (`tidy.downloads` respecte toujours `ask` et
  `never`). PSScriptAnalyzer est un téléchargement géré, vérifié par sha256, depuis la
  PowerShell Gallery au lieu d'un module réservé à l'hôte, et C# obtient un vrai
  exécuteur dotnet-format. Correctifs : les en-têtes de diff et les chemins `\\?\` de rustfmt 1.9 sont
  analysés, les gros rapports Biome ne s'effondrent plus à zéro constat quand la
  sortie est fragmentée, la corrigibilité est classée via `biome explain`, et
  la règle des commentaires d'historique ne supprime que les commentaires entièrement historiques
  et ne dépasse jamais le commentaire (elle pouvait supprimer l'instruction suivante).
- Les lignes de la barre latérale partagent une étiquette d'état à côté du titre pour les éléments intégrés,
  plugins, compétences, serveurs MCP, planifications, webhooks et agents : rien quand
  c'est activé, sinon `Not used`, `Not installed`, `Installing… N%`, `Failed`
  ou `Not connected`. Les agents désactivés conservent leur ligne de modèle.
- FastDirect refuse de réempaqueter ou d'installer un `app.asar` dont la fermeture des
  dépendances de production est incomplète et se rabat sur une compilation complète, de sorte qu'un
  programme de mise à jour défectueux (`Cannot find module 'graceful-fs'`) n'est plus hérité
  par chaque mise à jour incrémentielle.
- Les workers d'agents récupérés ne sont plus ressuscités par les analyses de sessions
  ni par la liste d'agents du bureau ; les sessions terminées réenregistrées conservent
  leur véritable heure de fin, de sorte que les baux expirent au lieu de redémarrer chaque heure.
- Les modes d'orchestration `none`, `focused`, `balanced` et `swarm` remplacent le
  workflow Solo et se choisissent par session ; les réglages sont localisés.
- Bureau : les liens de chemins locaux dans le Markdown s'ouvrent dans l'éditeur, et l'éditeur
  ouvre des fichiers hors du projet.
- Browser Use sérialise les instantanés par page et renforce les chemins de stabilisation et
  de capture.
- Computer Use : un moteur de rendu d'overlay gelé est retiré et remplacé, l'état de
  récupération de la saisie survit au changement, et les fixtures d'overlay ne se terminent plus
  prématurément sur une machine à écran unique.
- Shell : les hôtes PowerShell ne bloquent plus d'office `grep`, `sed` et `awk` lors de la
  vérification préalable ; la description de l'outil oriente plutôt vers les outils dédiés. Les règles,
  compétences, le README et le nouveau `docs/context-efficiency.md` sont mis à jour.
- Le dépôt est formaté avec Biome 2.5.13 (`biome.json` fige le style
  existant), rustfmt, dotnet-format et PSScriptAnalyzer ; les imports inutilisés,
  helpers morts et exports utilisés seulement dans leur fichier sont supprimés.

## v0.9.168 - 2026-09-16

- La fermeture d'une session Computer Use envoie toujours sa propre demande de libération. La libération
  spéculative du minuteur d'inactivité était auparavant héritée tant qu'elle était en cours, si bien qu'une libération
  anticipée refusée pouvait laisser les revendications de worker et de fenêtre de la session qui se ferme
  bloquées jusqu'au redémarrage de l'application.

- Overlay de Computer Use : deux contrôles, Arrêter et Reprendre. Le bouton pause a
  disparu (toucher le bureau rend déjà la main à l'utilisateur) ; la pastille
  indique désormais pourquoi un contrôle est indisponible ou pourquoi une requête a échoué au lieu de
  réagir silencieusement. Arrêter récupère un échec de nettoyage verrouillé une fois que chaque worker de
  saisie s'est terminé, de sorte que l'hôte n'a plus besoin d'un redémarrage de l'application, et la
  confirmation de sortie du worker attend jusqu'à 5 secondes au lieu de 1.
- Computer Use capture une fenêtre à partir de sa propre surface rendue plutôt qu'en
  copiant le bureau, avec un budget de capture borné ; une libération de ressource non confirmée
  retire ce worker. Le clavier et la saisie en arrière-plan sont vérifiés
  avant tout envoi de saisie, de sorte qu'une voie non prise en charge ne fait rien. Une nouvelle
  commande attend que la libération de la session précédente soit confirmée. Arrêter attend aussi
  l'annulation du tour de l'agent, indépendamment du nettoyage natif de la saisie.
- Les attentes de Browser Use respectent l'annulation et refusent de mélanger une URL avec du texte d'un
  document ultérieur ; une restauration échouée de capture d'écran pleine page est terminale. Les sélecteurs
  CSS conservent les espaces internes, refusent les ensembles de correspondances surdimensionnés, et
  adressent chaque correspondance de façon unique. Les téléchargements simultanés partagent un seul total
  d'octets par session ; les invites d'approbation décrivent les actions et adresses, jamais les valeurs de formulaire.
- Code Tidy est un élément intégré installable, comme Office : Réglages → Intégré
  l'installe et l'active, et la compétence `code-tidy` pilote l'outil `tidy`.
  L'analyse détecte les langages d'un projet et résout chaque formateur ou linter
  à partir de la configuration du projet, puis des binaires locaux au projet, du PATH, ou d'un
  téléchargement géré vérifié par sha256 (ask, auto ou never). Il exécute Biome, ruff, clang-format,
  shfmt, shellcheck, StyLua, gofumpt, dprint, Air et Mago, ainsi que rustfmt,
  gofmt et PSScriptAnalyzer de la chaîne d'outils, et applique des packs structurels
  (suppression des commentaires d'historique, `debugger`, catch vide, marqueurs TODO) sur 31
  langages. `fix` est un essai à blanc sauf si apply est défini, et les écritures passent par le
  même pipeline que les autres modifications. Les licences des moteurs sont livrées avec l'outil.
- Les appelants et appelés de `code_graph` proviennent de sites d'appel analysés, et non d'une recherche
  textuelle ; les références en forme d'appel utilisent aussi ces sites. Un ancien binaire de graphe
  qui ne peut pas les émettre échoue avec un remède de reconstruction au lieu d'une réponse
  vide. Les lignes de plan utilisent un seul vocabulaire de types, marquent les exports, affichent les
  signatures et imbriquent les membres sous leur parent. `find_symbol` préfère un
  fichier d'implémentation à un `.d.ts` compagnon et signale quand la
  déclaration se trouve hors des fichiers demandés. Les jetons d'identifiants proviennent de
  l'arbre d'analyse, de sorte qu'un nom qui n'apparaît que dans un commentaire ne compte plus
  comme une référence. Solidity, Haskell et HCL rejoignent l'ensemble d'extraction avec
  des arêtes d'import (24 langages d'extraction, 31 analysés). Les données de sites d'appel vivent dans
  un cache annexe, de sorte que le cache principal du graphe garde la même taille.
- Le binaire de graphe natif embarque tree-sitter 0.27 et ast-grep 0.45.3, ajoute les modes
  `--scan`, `--langs` et `--outline`, et extrait les symboles, imports
  et jetons d'identifiants à partir de règles YAML.
- Le plan de repli sur le graphe de l'éditeur de bureau analyse les nouvelles lignes de symboles en
  un plan imbriqué avec des icônes de type.
- Les questions de structure (exports, signatures, membres, appelants, importateurs) vont
  à `code_graph` avant `read` ou `grep` ; la formulation du parallélisme dans le workflow des outils
  est une règle unique.
- La maintenance de la mémoire ne promeut plus les résumés de conversation en instructions
  permanentes : il n'y a pas de troisième cycle. Le cycle 2 examine l'historique de recherche pour y trouver
  des doublons et la filiation sans réécrire les résumés. La mémoire permanente reste
  organisée par l'utilisateur via `memory` ; `recall` cherche par défaut dans tout l'historique,
  y compris les lignes précédemment archivées.
- L'utilisation d'Antigravity Gemini affiche les fenêtres partagées de 5 heures et hebdomadaires issues du
  résumé de quota du compte, et non des compteurs de catalogue par modèle, et les requêtes utilisent
  le canal quotidien sans basculement automatique d'hôte.
- Le volet Agents ne déploie que les lignes que vous ouvrez, affiche un nombre de descendants sur
  le lead, et indique « Waiting for agents » tant que des descendants travaillent encore
  au lieu de traiter le parent comme inactif ou terminé.
- Le compositeur propose une petite palette de commandes slash pour les commandes fréquentes
  (`/new`, `/model`, `/compact`, `/context`, `/goal`, `/inherit`, `/fast`) ;
  le registre complet s'exécute toujours quand on le tape directement.
- Les mentions de fichiers dans la conversation restent du texte brut jusqu'à ce que le chemin soit confirmé dans
  le Projet propriétaire ; les dossiers et documents s'ouvrent toujours dans le système, et les ouvertures
  dans l'éditeur transmettent un jeton d'accès.
- Le tableau d'utilisation de la barre latérale aligne libellés de fournisseurs, jauges, pourcentages et
  heures de réinitialisation sur une seule grille ; le catalogue de modèles garde sept récents.
- Une nouvelle session attend que les enregistrements de réglages en attente se terminent, et les outils MCP
  qui ont quitté le catalogue courant ne sont pas appelés en cours de tour.

## v0.9.167 - 2026-09-15

- Le démarrage de session indique quels outils shell courants sont présents (« Shell tools
  at startup »), mesurés dans le shell de connexion sous POSIX et dans le PATH du processus
  sous Windows, de sorte qu'un modèle ne devine plus `python` contre `python3` ni n'appelle
  `file` là où il est absent ; une réponse inconnue n'affiche rien.
- `read` n'affiche qu'une fois les fenêtres qui se chevauchent d'un même fichier, ne signale plus les
  plages de modification non lues comme déjà livrées, et n'hérite jamais d'une marque
  périmée « corps entier livré » après qu'un fichier a changé ; les lectures de tableaux respectent leur
  option sans fragment et la description énonce les vrais plafonds de sortie.
- `git` exécute les commandes chaînées par `&&` comme un tableau ordonné (jusqu'à 10) au lieu de
  les rejeter, et reconnaît les dépôts nus.
- Le cache de lecture de session respecte la liste d'outils autorisés, détecte les changements de `ctime` seul,
  ne stocke jamais un corps capturé avant un changement en cours de lecture, sépare les indices de décalage
  publics et hérités, et couvre les lectures publiques de tableaux.
- Les tableaux de `web_search` signalent comme erreurs les échecs partiels et totaux.
- Les règles et descriptions d'outils intégrés sont plus courtes pour le même comportement : la
  description de `shell` porte la table commande→outil et interdit les noms d'outils comme
  commandes shell ; les conseils sur `timeout_ms` couvrent les vérifications jetables ; les conseils de Lead
  qui ne s'appliquent qu'avec l'outil `agent` sont omis des workflows sans délégation ;
  les règles demandent toute action indépendante que les preuves actuelles
  exigent en une seule réponse, des corrections directement à partir de preuves décisives, un
  échantillon avant la logique d'analyse, et des tranches bornées pour les données volumineuses ou binaires.
- Runtime de bureau synchronisé avec les travaux actuels sur les bancs d'essai du navigateur et de l'ordinateur, et
  tests de contrat des outils renforcés en conséquence.

## v0.9.166 - 2026-09-14

- Studio reconnaît le compte ChatGPT sélectionné après la connexion au fournisseur et les
  changements de compte, en utilisant le même chemin d'identifiants que le chat sans se
  rabattre sur les identifiants d'un autre compte.

## v0.9.165 - 2026-09-14

- Le dock Contrôle de source garde sa fenêtre de lignes liée à la liste en direct : un
  dock reconstruit (changement d'onglet, de la surface de premier lancement à la liste) ne défile plus vers
  des lignes vides.
- Les ressources de version macOS sont téléversées par le script de suppression puis nouvelle tentative sur les deux
  architectures, de sorte qu'une exécution de reprise n'échoue plus sur une ressource qui existe déjà
  sur le brouillon masqué.
- Porte de publication : chaque voie passe au vert sur les runners hébergés. Linux installe
  NanumGothic pour les PDF en hangul et le LibreOffice actuel pour les relectures
  rendues ; la vérification du curseur Windows fige sa préférence de mouvement ; les attentes des tests
  suivent les contrats livrés.

## v0.9.164 - 2026-09-14

- Compactage des règles partagées et de Lead et des descriptions d'outils intégrés pour
  le même comportement en moins de jetons ; la description de `shell` ne garde que son rôle,
  la frontière avec les outils dédiés fichiers/recherche/Git, et le contrat des tâches
  d'arrière-plan.
- Les exécutions sans interface (`mixdog exec`) indiquent qu'aucun utilisateur n'intervient en cours d'exécution : la
  demande est traitée comme approuvée et menée à terme avant de faire un rapport,
  au lieu de s'arrêter pour poser une question à laquelle personne ne peut répondre.
- `apply_patch` saisi dans le shell n'est plus redirigé vers le moteur de
  patch ; le modèle appelle directement `apply_patch`/`edit`.
- Un Objectif arrêté se retire comme un objectif terminé : la prochaine invite de l'utilisateur
  l'archive, et la confirmation d'un arrêt l'archive immédiatement.
- Les statistiques d'utilisation attribuent les jetons et coûts mesurés par requête dans le registre,
  et l'explorateur d'utilisation du bureau affiche la ventilation qui en résulte.
- Correctifs du protocole du fournisseur Cursor.

## v0.9.163 - 2026-09-10

- Amélioration de la localisation de l'interface, de la sélection de la langue au démarrage, des menus natifs et
  du formatage traduit ; l'amorçage de la langue web reste à jour d'une mise à jour à l'autre.
- Renforcement de la propriété de la saisie de Computer Use et des vérifications en observation seule, confirmation des
  cibles de texte Electron avant la saisie, et amélioration de la gestion du curseur et des sessions.
- Amélioration de la recherche de fichiers native et des lectures par plage, et les calculs en cours
  invalidés ou annulés ne repeuplent plus le cache de résultats.
- Inclusion des bancs d'essai de recherche, de la couverture de non-régression, des audits de localisation et
  des livrables générés de projet et de documents.

## v0.9.162 - 2026-09-09

- La boîte de dialogue Fixer un objectif s'ouvre centrée dans le volet dont le compositeur l'a déclenchée,
  en n'assombrissant que ce volet ; les volets voisins restent visibles et utilisables et la barre
  de titre n'est plus assombrie. En dehors d'un volet, elle se rabat sur la couche de la fenêtre.
- Un volet actif ne recouvre plus la poignée de séparation sur son propre bord : un volet de navigateur
  (ou tout volet actif) peut de nouveau être redimensionné depuis sa limite gauche/haute.
- Web fetch signale une étape qui expire à l'échéance totale comme
  `FETCH_TIMEOUT` au lieu de `STAGE_TIMEOUT`.
- Computer Use utilise par défaut la livraison en arrière-plan pour les saisies sémantiques prises en charge ;
  `foreground_unavailable` demande désormais à l'utilisateur d'activer la fenêtre cible
  au lieu de décrire un échec de verrou d'avant-plan.
- L'exécution de publication de la v0.9.162 s'est arrêtée à la porte de test et n'a rien livré ; ses
  notes ci-dessous sont livrées par cette version.

- Mixdog est désormais sous licence Apache-2.0 au lieu de MIT. Les composants tiers
  conservent leurs licences et mentions d'attribution existantes.

- Browser Use et Computer Use demandent une fois par session avant leur premier appel
  en direct. Le premier appel `browser`/`browser_devtools` ou `computer` d'un modèle
  dans une session passe par l'invite d'approbation d'outil avec l'action qu'il veut
  effectuer ; l'autoriser couvre le reste de la session, le refuser renvoie la
  raison au modèle avec l'instruction de ne pas réessayer, et un redémarrage redemande.
  Les sessions sans interface d'approbation (sans interface, appartenant à un agent) ne sont pas soumises à cette porte.
  `setup set_first_use_approval name:browser|computer enabled:false` la désactive
  par capacité, et `MIXDOG_BRIDGE_FIRST_USE_APPROVAL` la remplace par
  processus.

- Browser Use fusionne deux gestes avec ceux qui les entourent. Une case à cocher ou un bouton radio se règle par `fill` avec `checked` au lieu de `text` — pour un seul contrôle,
  un élément de `fields` ou une étape de `sequence` — de sorte que l'action `check` distincte a
  disparu ; et `forward` a disparu, puisque l'instantané précédent montrait déjà
  l'URL vers laquelle faire `navigate` tandis que `back` reste un geste. `locate` et `extract`
  restent : le premier est une recherche visuelle (pixels) sans équivalent sémantique, le
  second lit des lignes à travers des cadres et des racines shadow ouvertes qu'`evaluate`
  ne peut pas atteindre.

- `capture` de Computer Use abandonne ses réglages `quality`, `maxWidth` et `max_ocr_words` :
  les valeurs par défaut ajustées de l'hôte s'appliquent (qualité JPEG, largeur de réduction et
  plafond de mots OCR que le budget d'éléments borne déjà), et un détail illisible est un
  `zoom` plutôt qu'un réencodage. Les filtres d'éléments (`query`, `role`,
  `visible_only`, `include_noninteractive`, `continuation`) et la géométrie de déplacement de `window`
  disent désormais ce qu'ils font au lieu de rester dans le schéma sans explication.

- Browser Use et Computer Use énoncent leur échelon dans l'échelle des outils là où le
  modèle décide. La description de `browser` s'ouvre sur « last resort: prefer
  web_fetch, an MCP tool, or a CLI in shell », `computer` sur « last resort
  after an MCP tool, shell/CLI, and Browser Use; never a stand-in for a page
  action browser refused », et les règles partagées et les deux compétences portent la même
  échelle, de sorte qu'un service doté d'une API ou d'une CLI est atteint par celle-ci au lieu de
  passer par un écran. Aucune description n'a grossi : l'échelle a remplacé une formulation que les compétences
  possédaient déjà.

- Browser Use devient deux outils. `browser` conserve le travail quotidien sur les pages — navigate,
  snapshot, read, click, fill, formulaires, boîtes de dialogue, onglets, téléchargements, lectures
  de console et de réseau — tandis que les contrôles développeur `emulate`, `cookies`,
  `storage`, `intercept`, `init_script` et `performance` passent à l'outil différé
  `browser_devtools`, qui pilote les mêmes pages et connexions et
  charge son schéma lors de son premier appel. Le schéma quotidien abandonne les 33
  champs que seules ces actions utilisaient (attributs de cookies, géolocalisation, bridage du CPU,
  corps d'interception, options de trace), les notes de champs de chaque outil ne nomment
  que ses propres actions, et un appel qui atteint le mauvais outil est refusé
  avec l'outil à appeler. L'hôte, son registre d'actions, sa politique d'approbation et
  le banc d'intégration conservent le contrat d'actions partagé unique.

- Les schémas d'outils intégrés n'énoncent que des contrats. Les descriptions et notes de champs des outils `office`, `computer`,
  `media` et `setup` abandonnent les phrases de méthode et de politique
  que leurs compétences possèdent déjà — regroupement, quand faire un instantané ou
  `describe`, corriger un audit dans le même tour, réutilisation de `design.content`, gestion
  des macros, ne pas réorganiser, le contenu de l'écran n'autorisant jamais une action,
  interrogation vidéo, la procédure d'approbation de suppression — ce qui retire environ 2,2 Ko
  (office −878 o, computer −492 o, media −432 o, setup −424 o) de la surface d'outils
  envoyée à chaque tour. Les compétences pptx, xlsx et pdf portent désormais les
  règles qui ne vivaient que dans le schéma (un lot d'opérations connues,
  `describe` seulement pour un champ inconnu, contenu de document non fiable),
  et la compétence computer-use énonce le contrat d'appel une fois au lieu de répéter chaque
  phrase du schéma.

- Browser Use nécessite moins d'appels par tâche. `click`, `fill`, `type`, `select`,
  `hover`, `upload` et `scroll` — ainsi que chaque élément de `fill.fields` et chaque étape de
  `sequence` — acceptent une `target` sans instantané (`{role, name}`, `{name}`
  ou `{selector}`) au lieu d'une `ref` : l'hôte observe lui-même la page,
  n'agit que sur exactement une correspondance (plusieurs correspondances de sous-chaîne se résolvent vers
  l'unique correspondance exacte), et une cible ambiguë échoue en listant les candidats et
  leurs nouvelles refs. `query` sur `snapshot`, `read` et `wait` fait correspondre
  des mots-clés séparés par des espaces avec OU (les correspondances de tous les mots-clés sont classées en premier)
  et accepte les expressions régulières `/pattern/i`, et un filtre qui ne correspond à rien indique
  combien d'éléments ou de caractères il filtrait. Les contrôles transparents ou avec
  pointer-events:none ne sont plus refusés d'emblée : une case à cocher masquée est cliquée via son libellé,
  et la protection de cible de saisie accepte l'activation du libellé.
  `fill` sur un éditeur `contenteditable` remplace le contenu comme une saisie après un tout-sélectionner
  au lieu d'écraser son DOM.
  Les réponses indiquent « No observable change » quand un geste a laissé le document, l'URL
  et les valeurs des contrôles intacts, `brief:true` ne liste que les éléments nouveaux
  ou modifiés depuis la précédente observation, les erreurs de console ne sont signalées qu'une fois
  quand elles sont nouvelles, et une postcondition déjà satisfaite est un avertissement et non une
  erreur. Les instantanés marquent les champs de fichier avec `file-input`, `accept=…` et
  `multiple` ; les captures d'écran pleine page ancrent les éléments fixes et collants dans le flux
  pour la capture ; et les cookies de session sont stockés chiffrés avec le trousseau
  du système et restaurés au lancement afin que les connexions survivent à un redémarrage de l'application.

- L'habillage au-dessus de la saisie du prompt — capsule Objectif, progression du runtime, approbation
  d'outil, barre de contexte du brouillon et emplacement de revue de tour — vit désormais dans un seul
  `ComposerDock`, et la transcription ne tressaute plus quand cet habillage se résout :
  l'emplacement de revue reste réservé tant que la première lecture faisant autorité du worker d'une portée
  est en cours, de sorte qu'un diff arrivant après l'affichage de la transcription occupe la
  géométrie existante au lieu de redimensionner de nouveau la fenêtre d'affichage. L'espace libéré
  n'est jamais retenu par un minuteur. L'hôte de bureau cesse aussi de relire toute une
  session après chaque invite acceptée (la récupération « missing baseline » du journal du
  démon) : une trame de réponse ou de voie qui répète la révision que la
  projection détient déjà est un état appliqué, pas une base croisée. Les basculements de montage/démontage
  de la capsule Objectif sont attribuables sous `MIXDOG_DESKTOP_PERF=1`.

- Une capsule Objectif n'apparaît plus et ne disparaît plus d'elle-même. Deux chemins de publication
  produisaient le clignotement : la pulsation de route de 2 s lisait l'enregistrement brut de l'Objectif alors
  que l'archive d'entrée utilisateur d'un Objectif terminé était encore en cours d'écriture, de sorte que la
  capsule retirée revenait pendant une image ; et sous Windows une lecture de l'Objectif tombant dans le
  remplacement atomique du fichier (`EPERM`/`EACCES`/`EBUSY`, ou l'écriture en cours du runtime
  lui-même) apparaissait comme « aucun Objectif » pour cette image. Les publications de route
  lisent désormais l'Objectif à travers le masque d'archive de poursuite d'objectif,
  et le stockage des Objectifs répond à ces lectures à partir du dernier enregistrement validé.

- Browser Use ne s'arrête plus pour demander une approbation : la boîte de dialogue « Autoriser une fois » du bureau
  qui protégeait `upload` et `clear` du cookie/localStorage partagé a disparu, le
  champ `confirm` quitte le contrat de l'outil browser, et la compétence browser-use
  abandonne ses règles de feu vert dans la conversation. `MIXDOG_BROWSER_CONFIRM_ACTIONS`
  et `MIXDOG_BROWSER_DENY_ACTIONS` restent le seul moyen de confirmer ou de refuser
  des actions nommées.

- La colonne de lecture des volets — compositeur, transcription et dock Studio — n'attend
  plus qu'un volet de 1536 px s'élargisse : à partir de 768 px elle tient 800 px jusqu'à ce
  que le volet dépasse 1000 px, puis suit 80 % du volet jusqu'au plafond de 1000 px
  à 1250 px, de sorte que les fenêtres 1536/1680 et 1920 avec un panneau latéral ouvert
  ne restent plus bloquées à 800 px, et un séparateur franchissant le palier ne fait plus sauter
  la colonne de 200 px.

- Le panneau Sessions s'ouvre sur deux lignes de lancement fixes, `New task` et
  `New Studio`, épinglées au-dessus de la liste des sessions. Studio quitte donc la barre
  d'activité : son entrée de barre réservée au lanceur et les exceptions de lanceur dans la
  disposition de la vue latérale, le dock des volets et les bascules de dock sont retirées, et une disposition
  de barre enregistrée abandonne l'identifiant `studio` au chargement.

- La destination Workflows de la barre d'activité est intégrée au panneau Projets : une
  barre d'outils `Project | Workflow` — le sélecteur de sections du panneau Extensions, désormais
  partagé comme un seul composant `SidebarSectionToolbar` — bascule entre la liste
  des projets et les packs de workflows, agents par défaut et définitions d'agents ;
  le `+` de l'en-tête suit l'onglet Projet ; `/workflow` et `/websearch` ouvrent l'onglet
  Workflow ; et une disposition de barre enregistrée abandonne la vue `workflows` retirée
  au chargement.

- Le kit de la compétence pptx gagne un vocabulaire de conception à la manière des systèmes de conception
  à jetons : `palette()` dérive trois intensités de trait (`lineSubtle`,
  `line`, `lineStrong`) et quatre couleurs d'état (`T.state.positive | warning |
  critical | informative`, chacune en `solid` / `weak` / `text`, au contraste
  garanti et maintenues sous la bande saturée du relecteur afin qu'une colonne de verdict
  ne déclenche jamais `accent_hue_overuse`) ; chaque distance repose sur une seule échelle d'espacement
  (`SPACE`) nommée par relation (`GAP.bind` / `within` / `between`, `GUTTER`,
  `PAD`, `M`) ; chaque rôle de texte porte un interligne fixe ; les supports répétés
  (badge, encart, série de chevrons, stat, tableau) lisent leur anatomie dans `SPEC`
  avec des variantes de `tone`, un pas d'échelle de `stat` et un assistant `statBand()` ; les icônes
  correspondent à quatre bandes de taille ; et un nouveau `references/writing.md` fixe les règles de
  phrase, de registre, de nombre, de date, de montant, d'unité et de marge de traduction, avec des liens
  depuis les compétences docx et xlsx. Chaque support de spécification signe sa forme, et le
  reçu de composition relit les signatures (`slides[].specs`,
  `deck.specs` : nombre, diapositives, variantes, anatomies) de sorte qu'un support dont la taille
  de texte ou la police a dérivé entre les diapositives apparaît comme une seconde anatomie.

- Les jetons de conception Office dérivent les mêmes quatre couleurs d'état (`positive`,
  `warning`, `critical`, `informative`, chacune avec un champ `Weak` et un palier
  `Text`, au contraste vérifié par rapport au canevas, au panneau clair et au champ) ;
  les portes de décision docx et xlsx dessinent Release et Stop sur les états positif
  et critique au lieu d'une teinte littérale et du second accent, et le `calloutTone` d'une section
  `compose_document` place son encart sur un état.
  La zone d'impression d'un tableau de bord `compose_sheet` suit désormais le panneau de décision,
  de sorte qu'une porte Stop dans une colonne au-delà du canevas n'est plus coupée de
  la page rendue et exportée.

## v0.9.161 - 2026-09-06

- Les audits Office mesurent Arial, Helvetica, Times New Roman, Courier New,
  Calibri, Cambria et Georgia dans leurs polices ouvertes à métriques compatibles
  (Liberation, Arimo/Tinos/Cousine, Carlito, Caladea, Gelasio) partout où
  l'originale n'est pas installée, au lieu de signaler la police indisponible
  et d'approximer l'ajustement — une machine Linux dotée des polices Liberation
  audite désormais une présentation comme le fait Windows. Le paquet racine gagne les voies
  `test:slow` et `test:live`, et les voies de runtime de la CI installent les polices Liberation.

- Les commits du Contrôle de source prennent un résumé saisi à la main plus une description
  facultative : les préréglages de messages de commit, les vérifications de format, l'autocomplétion et
  la génération par IA quittent la carte Git et GitHub et le formulaire de commit, et les
  préférences héritées `desktop.git` ne sont ni lues ni écrites.

- Computer Use abandonne l'éditeur d'autorisation côté réglages (verrou de fenêtre et
  d'action, expiration) : il reste sans restriction par défaut avec les garde-fous
  permanents — protections de saisie, gestion de l'élévation, reprise en main par l'utilisateur, protections
  d'environnement — et un fichier d'autorisation enregistré ne peut plus expirer en
  verrouillage. La restriction des autorisations au sein du processus subsiste pour un hôte intégrateur via
  `MIXDOG_COMPUTER_POLICY_FILE` et `host.updateAuthorization`, rien n'est
  persisté, et l'export des diagnostics d'échec reste. L'outil gagne
  `wait_for_user` : lorsque l'utilisateur prend la main, le modèle attend un intervalle
  borné et capture ensuite un état frais au lieu de deviner
  des autorisations.

- Chaque carte d'Extensions et d'Intégré ouvre la même boîte de dialogue de détail — plaque
  d'identité et titre, sections au même rythme, pied de dialogue présentant une hiérarchie d'actions avec
  l'action destructrice rangée à gauche, un seul style de bouton d'action — et les boîtes de dialogue
  d'ajout/modification de Projets la rejoignent. La carte Git et GitHub porte le compte GitHub
  (connexion gh par code d'appareil) ; la carte Local Provider
  liste les modèles installés avec taille, contexte et état d'exécution, une section Chargement du modèle
  pour le déchargement en cas d'inactivité, et des informations en direct (build du runtime, GPU,
  mémoire libre, serveur), tandis que la réparation et la vérification restent pilotées par le chat
  via la compétence local-provider. Les informations de statut/plateforme quittent les boîtes de dialogue
  parce que le contrôle d'en-tête et le badge de liste les indiquent déjà. Les
  feuilles de style des extensions sont scindées en `extension-list.css`,
  `extension-dialog.css`, `extension-editors.css` et `rail-controls.css`.

- Objectif : reprendre un Objectif en pause et démarrer sa tâche approuvée forment une seule
  écriture durable — `resume` accepte des mises à jour et ajouts de tâches, marquer une tâche
  `in_progress` reprend l'Objectif, et la simple tenue de registre n'accorde jamais
  l'approbation. L'état d'un Objectif en pause parvient au modèle lorsque la requête est
  préparée, après l'hydratation, au lieu d'un rappel ponctuel sur la réponse de l'utilisateur,
  de sorte qu'aucun tour ne peut perdre le fait qu'un Objectif attend.

- Les téléphones synchronisent leurs vues à la reconnexion : après la poignée de main sécurisée, le
  navigateur demande au bureau une base cohérente unique de ses sessions ouvertes
  (instantané, liste des sessions, pool d'agents, états des sessions) et les publications en direct
  sont retenues jusqu'à son arrivée, de sorte qu'un téléphone reconnecté n'affiche plus une
  transcription périmée et ne manque plus la fin d'un tour. La transcription remise aux téléphones
  omet le matériel de relecture du fournisseur, dans les deltas comme dans les bases.

- La création de nouvelle tâche survit à une connexion distante interrompue : chaque requête
  porte un reçu durable, de sorte qu'une nouvelle tentative après un délai dépassé ou une reconnexion aboutit à
  la même session réservée au lieu de créer un doublon, et l'observateur du
  magasin de projets se rétablit de lui-même et réconcilie le catalogue pendant son indisponibilité.

- Les conversations et les barres d'onglets s'affichent sans saut : une transcription visitée
  s'affiche une fois que ses lignes visibles et son décalage de fin concordent d'une image à l'autre (borné par
  une seconde, de sorte que le streaming ou une police lente ne la masque jamais), et une barre d'onglets
  décide du débordement d'après la disposition de destination plutôt que d'après un onglet à moitié agrandi.

- Les actions du catalogue Local Provider (`searchLocalProviderModels`,
  `inspectHuggingFaceModel`, `registerHuggingFaceModel`) existent sur la surface
  de session sur laquelle le démon les résout, de sorte qu'un appel setup acheminé via le
  bureau n'échoue plus comme une action de session indisponible.

- Les catalogues de langues de l'interface de bureau sont de nouveau synchronisés avec le moteur de rendu : les chaînes
  que les vues de contrôle de source et les commandes slash lisent via `t()` manquaient
  dans tous les catalogues (l'onglet affichait « History » en coréen), les phrases coréennes de l'ancien
  pack de traduction retiré sont migrées dans `ko.json` afin que les libellés dynamiques (« Ln 42 », « Callers of … ») soient de nouveau traduits,
  et les chaînes des menus et boîtes de dialogue natifs sont générées à partir des mêmes catalogues. Le coréen est
  complet ; les dix autres langues se rabattent sur l'anglais pour les phrases plus
  récentes jusqu'à ce qu'elles soient traduites.

- La compilation de l'importateur de navigateur remplace une extraction amont à moitié écrite sous TEMP
  au lieu d'échouer dessus. Banc de test : les suites du moteur de rendu peuvent importer
  des modules qui tirent une feuille de style de fonctionnalité (un import `.css` se résout en un
  module vide sous Node), la vérification d'import du démon sur artefact compilé s'exécute dans la
  voie live après une compilation, et les fixtures de chemin du magasin de réglages se résolvent dans la
  grammaire de chemins propre à l'hôte.

- La compétence et le runtime pdf adoptent la discipline d'inspection d'abord des compétences PDF
  de référence. Lecture : un instantané signale `encrypted` et
  `passwordRequired` au lieu de l'erreur propre de pdf-lib, `open`/`snapshot` avec
  `password` lisent le texte d'un fichier verrouillé pour cet appel sans conserver
  le mot de passe, toute modification d'un fichier chiffré renvoie vers `secure` → decrypt,
  les pages portent leur taille et leur rotation, les signets reviennent sous `outline`
  avec la page que chacun ouvre, et l'extraction de texte (instantanés Office, pièces jointes du chat,
  outil read) conserve les fins de ligne sous forme de sauts de ligne afin que les paragraphes et les lignes de tableau
  survivent. Formulaires : les champs exposent le type
  `text|checkbox|radio|dropdown|optionlist`, `options`, `readOnly` et
  `multiline` dont un remplissage a besoin ; `fill_form` nomme un champ ou une option inconnu
  avec ce qui existe et signale `filled` ; `add_form_field` et
  `create` acceptent `optionlist`, `required`, `readOnly`, `maxLength` et
  `fontSize` ; le contrôle signale une case trop petite pour être utilisée (`formIssues` à la création,
  `field_too_small` dans `issues`) ; `preview_fields` écrit une copie avec chaque
  champ et toute case proposée encadrés et nommés, afin qu'un rendu montre le placement
  avant un remplissage ; une liste déroulante ou une liste avec des options coréennes
  n'échoue plus à la création parce que le widget est peint avec la police embarquée
  dès le départ ; et un champ multiligne prend par défaut 11 pt au lieu de la
  taille automatique de pdf-lib, qui dessinait la première ligne énorme et omettait le reste.
  Polices : `create`, `add_text`, `watermark`, `fill_form` et l'OCR embarquent
  d'eux-mêmes une police Unicode installée quand le texte est coréen, CJK,
  cyrillique ou grec (`pdf-fonts.mjs` ; `fontPath` choisit toujours ; `detect`
  nomme la police comme `portable.pdfUnicodeFont`). Écriture : `create` coupe
  la prose sans espaces par caractère, respecte `\n`, coupe les cellules de tableau et agrandit
  les lignes, répète l'en-tête après un saut de page, numérote les sorties de plusieurs pages,
  et accepte `columnWidths`, le `level` des titres, l'`align` des images, `orientation`,
  `footer` et davantage de formats de page. Modification : `merge_pdf` accepte `sources:[path | { path,
  pages, title }]`, `index` et `bookmarks:true` ; `add_bookmark` écrit une
  entrée de plan ; `extract_pages` écrit vers `output` et `split_pages` un
  fichier numéroté par page ou par `every` pages sans toucher au document de session ;
  `extract_attachment` effectue un aller-retour des fichiers embarqués ; `rotate_pages`
  s'ajoute à la rotation courante ; `delete_pages` conserve une page ; `compress`
  signale `bytesBefore`/`bytesAfter` ; `add_text` accepte `align:'center'|'right'`
  et numérote un fichier existant via `{page}`/`{pages}` ; `highlight` marque
  chaque correspondance de `find` (ou une case ; `wholeWord`, `regex` et `first` la restreignent)
  avec une marque en fusion multiplicative qui laisse le texte lisible ; `add_link`
  pose un lien invisible sur une correspondance qui ouvre une URL ou une autre page,
  ou avec `urls:true` rend chaque adresse http(s) du texte cliquable d'elle-même ;
  `stamp_image` tient dans les marges sauf dimensionnement explicite ;
  `issues` ne signale plus deux fois une page numérisée et nomme le contenu actif
  (`active_content` : JavaScript, Launch, actions à l'ouverture, liens vers des fichiers ou
  d'autres schémas non web) sans le suivre. Analyse : `pdf-layout` avec
  `query` ne renvoie que les correspondances avec leurs cases ; ses zones de texte suivent
  la ligne sur les pages pivotées et pour le texte en diagonale, et cet outil ainsi que l'instantané signalent
  `origin` quand une boîte de page ne commence pas en 0,0. Les marques de `find` inversent la
  transformation d'affichage pour gérer à la fois les décalages d'origine et les rotations de page de 90/180/270 degrés
  sans réorienter le document ; `first:true` préserve l'ordre des lignes du document
  à chaque rotation. La mise en page liste les liens de
  chaque page (`url` ou la `page` cible) et ajoute les filets (`lines`) et
  les `boxes` de chaque page (petits carrés marqués `checkbox`), ce dont a besoin le remplissage d'un formulaire
  sans champs ; `pdf-tables` lit un tableau à bordures à partir de ses
  rectangles de cellules (`source:'ruled'`, cellules multilignes intactes) avant
  la supposition par alignement du texte (`source:'alignment'`) et écrit un CSV par tableau
  quand `output:<dir>` est donné, comme `pdf-images` écrit des fichiers PNG et signale
  où se trouve chaque image sur la page ; l'OCR ajuste
  chaque mot invisible à sa case afin que la couche de texte garde des espaces simples. Les
  aperçus de page (`render`, `qa`, `finalize`) fournissent à pdf.js ses polices standard
  intégrées, de sorte qu'une page composée en Helvetica ou Times ne s'affiche plus
  avec un espacement des lettres. L'adaptateur est scindé en `pdf-writer`, `pdf-forms`,
  `pdf-draw` et `pdf-fonts`, et la compétence est réécrite sous la forme inspecter →
  créer → modifier → sécuriser → vérifier, avec l'exigence de qpdf (PATH ou
  `MIXDOG_QPDF_PATH`), la mise en garde sur les bits de permission, et la limite du
  texte en place énoncées.

- La compétence et le runtime xlsx adoptent la discipline de modélisation qu'un lecteur attend
  d'une feuille de calcul : un audit de formules indépendant du backend (partagé par portable
  `issues` et la revue de qualité) signale une référence de feuille à plusieurs mots sans
  guillemets, un lien vers un classeur externe, un pourcentage stocké comme entier,
  une année sous séparateur de milliers, et un chiffre stocké comme texte
  pour chaque classeur (plus, à titre d'information, une longue feuille dont l'en-tête
  n'est pas figé et une colonne de tableau de nombres au format Standard), et
  sous `auditProfile:'financial-model'` un taux en dur dans une formule, une division
  non protégée, une formule isolée qui rompt le motif de sa ligne ou de sa colonne,
  une référence isolée au-delà de l'étendue peuplée de la feuille (le décalage d'une unité qui
  se recalcule sans erreur), un codage en dur dans une ligne de formules, et des entrées
  indiscernables des
  formules, ainsi qu'une entrée lue par une formule qui ne porte aucune note de source et un
  rapprochement de la feuille Checks qui s'évalue à FALSE — sur les deux backends, puisque
  `issues` d'Excel intègre désormais l'audit partagé aux constats propres de l'hôte. Les instantanés
  exposent le format numérique, la police, la couleur et le remplissage de chaque cellule stylée (les
  entiers BGR d'Excel se normalisent vers la même forme RRGGBB), les notes héritées par cellule et par
  feuille, les tableaux Excel par feuille (les enregistrements d'un tableau sont des données dont le tableau
  constitue la source, de sorte que l'audit ne demande une note que pour les hypothèses extérieures),
  les plages fusionnées et les volets figés dans la forme d'Excel,
  les booléens comme booléens, le `defaultStyle` du classeur, et un
  résumé `document.conventions` (police par défaut, polices utilisées, formats numériques
  par colonne, marqueurs d'entrée, exemples d'entrées) afin qu'une modification puisse suivre les conventions
  propres au fichier ; `set_formula` met entre guillemets les noms de feuilles à plusieurs mots que
  le classeur contient (et, sur les deux backends, tout nom à plusieurs mots écrit
  avant `!` et une référence) et signale la `normalizedFormula`, le recalcul LibreOffice
  renvoie un `status` avec `totalErrors`, un `errorSummary` par
  type d'erreur et cellule, et les `unparsedFormulas` que LibreOffice a réécrites en
  minuscules, et `finalize` refuse un classeur dont le recalcul a trouvé la moindre
  erreur même si la revue a été ignorée. La compétence réécrit ses règles autour de zéro
  erreur de formule, de formules plutôt que résultats collés, de spécifications littérales, d'hypothèses
  documentées, de la légende de saisie et du respect des conventions d'un fichier existant,
  avec `references/model-conventions.md` pour les couleurs, formats numériques,
  la structure, la feuille Checks et la citation des sources.

- La compétence pptx s'ouvre sur une table de routage — une nouvelle présentation est un script
  `author`, une présentation existante passe par `open` → `snapshot` → `batch`, et la lecture est un
  `snapshot` paginé ou l'extracteur de source — et résout ses chemins de scripts
  via `${MIXDOG_SKILL_DIR}`, de sorte que le contrôle qualité des pages, le relecteur indépendant et
  `source-extract.mjs` (déplacé dans la compétence avec un test) s'exécutent depuis n'importe quel
  Projet. La section de modification nomme les pièges que le runtime a réellement :
  une diapositive dupliquée partage sa partie de graphique avec sa source, la décoration du modèle
  reste là où le nombre de lignes de la zone réservée l'a placée, et un script
  qui déclare son propre `pres` hérite du canevas 10 × 5,625 po de pptxgenjs.
  Les compétences docx, xlsx et pdf ajoutent les déclencheurs que les utilisateurs écrivent réellement
  (« Word », « Excel », « PDF 읽어 », « PDF 만들어 »), et la compétence docx indique comment un
  instantané montre un saut de ligne.

- L'édition PowerPoint portable résout la cible de relation d'un graphique comme le fait
  le paquet : pptxgenjs l'écrit comme un nom de partie absolu
  (`/ppt/charts/chart1.xml`), que `set_chart_data` et les autres opérations de graphique
  sur une présentation créée signalaient auparavant comme une partie manquante. Les
  instantanés portables conservent désormais les sauts de ligne et fins de paragraphe sous forme de sauts de ligne — le texte des formes
  et des notes d'une présentation, et le texte des paragraphes, cellules, commentaires,
  révisions, notes et contrôles de contenu d'un document Word — au lieu de coller « 4주차 » et
  « 잔존율 ».

- Les barres d'onglets des volets animent les ajouts et fermetures sur l'horloge de l'interface : un nouvel onglet
  grandit à partir de rien tandis que ses voisins rétrécissent, de sorte que la rangée ne déborde jamais de la
  barre pour y revenir, et un onglet fermé se replie sur place tandis que les
  survivants glissent dans son espace au lieu de sauter. Un brouillon promu en
  session s'échange toujours instantanément, et la barre abandonne son état inutilisé de maintien de largeur.

- La création Office gagne trois structures de qualité de sortie : `author` et
  `batch` renvoient un `audit` mesuré (ajustement, limites, contraste, espacement, paquet)
  avec des comptes par diapositive et une obligation de correction dans le même tour qui compte ses tours ;
  `author` refuse de livrer une présentation dont les chiffres n'ont aucun fait derrière eux
  (`facts_gate`) sauf si le brief déclare `facts: sample`, ce qui transporte une
  mention de chiffres illustratifs à travers qa et finalize ; et la compétence pptx
  livre `scripts/qc-pages.mjs`, un correcteur par page qui exécute une session neuve
  par diapositive avec le seul outil office et n'adopte sa copie de travail que si
  les défauts mesurés de la page n'ont pas augmenté et qu'aucune autre diapositive n'a changé.

- Les compétences scindent leur ligne de liste en une description d'une phrase et un
  déclencheur `when_to_use` ; la liste de compétences du modèle affiche `description — trigger`
  coupé à 250 caractères, l'éditeur de compétences gagne un champ Déclencheur distinct, le
  validateur skill-creator avertit quand une ligne de liste sera coupée, et chaque
  compétence intégrée est réécrite dans la nouvelle forme.

- L'îlot Objectif de la session aligne sa liste de tâches sur l'en-tête replié,
  sépare les lignes par des filets, et se replie au clic extérieur ou sur Échap.

- La surface du téléphone suit l'habillage du bureau : la jauge de contexte se place à côté du
  déclencheur de modèle du compositeur, les marques de la barre d'outils partagent la famille lucide,
  et la feuille de droite s'ouvre comme une seule unité de dock dont l'en-tête porte les mêmes
  bascules de vue que la bande du bureau.

- Les compétences intégrées sont livrées depuis une source de compétences embarquée, et les guides Office
  deviennent des compétences pptx, docx, xlsx et pdf conditionnées par la fonctionnalité qu'elles pilotent.
  Les Réglages regroupent les compétences, serveurs MCP et hooks dépendants sous leur plugin
  ou fonctionnalité intégrée.

- Office crée des présentations PPTX à partir de scripts pptxgenjs avec un guide de conception,
  un kit d'aides, un menu de mises en page et un contrôle qualité visuel mené par le modèle, et tolère les
  différences d'ordre des enfants de présentation et de graphique.

- Les appels d'outils convertissent les arguments en texte JSON vers la forme de leur schéma déclaré,
  y compris les schémas de registre internes.

- Browser Use scinde la politique d'URL, d'onglets, de partitions, de masquage et de scripts d'instantané
  en modules dédiés ; Computer Use affine le modèle d'overlay, le backend de saisie
  et la coordination de session.

- Le préchauffage du démarrage du bureau, la restauration du dock latéral, le calendrier de réinitialisation de l'utilisation, les fichiers de
  découverte appartenant au pont et la récupération du transport de session gardent les démarrages à froid et les
  reconnexions réactifs. Les déploiements FastDirect préchauffent le runtime installé.

- Le lanceur de tests sépare les niveaux rapide, lent et live avec des rapports de durée ;
  les magasins de sessions mettent en cache les résumés de transcription et les balayages de listes ; les utilitaires de
  requêtes de fournisseurs renforcent la gestion du protocole d'Anthropic, Cursor et OpenCode.

## v0.9.160 - 2026-09-02

- La TUI installe désormais son runtime Ink patché depuis une ressource de version versionnée.
  Les compilations de production, bancs de trames et sondes de charge résolvent le paquet
  installé tout en préservant le comportement personnalisé du curseur, de la sélection et du rendu.

- Le démarrage du bureau révèle désormais des coques de volets utilisables avant la fin de l'hydratation, plus lente,
  du catalogue et du runtime. Les surfaces Navigateur, Terminal, Éditeur et dock latéral
  se restaurent indépendamment, avec des sondes de disponibilité ciblées et des services
  hôtes différés qui gardent les démarrages à froid réactifs.

- Browser Use et Computer Use disposent désormais de modules hôtes par rôle au lieu de
  monolithes à plat. Les actions du navigateur partagent un routage explicite, un cycle de vie d'invité et
  des contrats de réponse, avec une gestion renforcée des sélecteurs de fichiers et des boîtes de dialogue, tandis que
  Computer Use sépare les responsabilités de découverte, d'observation, de saisie, de session, d'overlay et
  de backend avec une couverture de sécurité élargie.

- Les modules du runtime Office sont organisés par rôles : cœur, conception, qualité, portable,
  PDF, COM et banc d'essai. La composition libre, la sélection de mise en page pilotée par références,
  les scènes PowerPoint créées et les contrôles d'assurance rendus améliorent
  la qualité visuelle sans affaiblir la sortie modifiable ni les frontières de transaction.

- Les sessions Anthropic OAuth apprennent désormais une version minimale de CLI exigée par le fournisseur,
  ne conservent que les mises à jour vers le haut sûres, et retentent une fois la requête rejetée sans
  remplacer une configuration de version explicite.

## v0.9.159 - 2026-09-01

- La recette de publication Windows vérifie désormais l'inventaire canonique de 16 éléments des réglages
  au lieu de l'ancien décompte antérieur à la navigation.

- Computer Use coordonne désormais les baux de cible au premier plan, recapture après les
  transitions de fenêtre, valide des séquences d'actions bornées et expose un overlay de
  reprise en main par l'utilisateur. Les chemins de capture, de clavier, de ciblage et de récupération sont
  scindés en modules ciblés avec une couverture d'hôte et de pont plus large.

- Browser Use gagne des registres limités à la session et des surfaces persistantes par conversation.
  Les vues de navigateur, de diff et d'utilitaires peuvent rester attachées au dock latéral de chaque
  conversation, tandis que les lectures de fichiers locaux remplacent le chemin dupliqué
  retiré de l'explorateur de dossiers.

- Le compactage à contexte neuf porte désormais une remise de Mémoire bornée, préserve la
  poursuite du tour actif et l'état de l'enveloppe d'outils, et garde stables les dispositions de cache
  du fournisseur au fil du compactage. L'ingestion de la mémoire projette la transcription compactée
  de façon cohérente au lieu de s'appuyer sur le chemin rapide retiré.

- La génération de présentations Office ajoute une direction créative, une grammaire de mise en page, un flux
  visuel sémantique, une revue esthétique du rendu et un score de qualité de publication, de sorte que
  les présentations produites sont plus variées et que les compositions faibles sont détectées plus tôt.

- Les remous de la vérification et de la plomberie de publication chutent nettement : le monolithe de
  3 500 lignes de tool-smoke est désormais composé de quatorze suites `node --test` ciblées sous
  `scripts/tool-contracts/`, avec des assertions fragiles sur la formulation exacte assouplies en
  contrats de phrases clés, la sélection des chemins de CI provient d'une source unique dans
  `scripts/release-paths.mjs` pour la porte de publication comme pour la planification du déploiement,
  et une publication ne réexécute pas la voie critique quand la porte a déjà
  vérifié exactement les mêmes commits.

- Aucune suite ne peut plus pourrir en silence : les derniers monolithes de test
  (provider-toolcall, session-transport, shell-hardening) sont des suites par domaine
  sous `scripts/`, la porte de publication exécute désormais les contrats d'outils
  et de compactage (recall-fasttrack) à chaque push soumis à la porte, et un balayage
  hebdomadaire `suite-health` exécute chaque script `test:*`/`smoke:*` enregistré
  via un catalogue de désactivation qui ouvre un ticket suivi en cas d'échec.

## v0.9.158 - 2026-08-31

- Le hub Extensions offre désormais à Git, Mémoire, Browser Use, Computer Use, Office
  et la voix un parcours cohérent d'installation, de progression, d'activation et de désactivation. Les runtimes
  facultatifs sont préparés à la demande, Office peut installer LibreOffice via le
  gestionnaire de paquets de la plateforme, et la désactivation de la voix préserve les ressources téléchargées.
- L'empaquetage du runtime de bureau est plus petit et plus déterministe : les charges utiles de fonctionnalités
  facultatives restent hors de l'application de base, le code du runtime est préparé une seule fois, les déploiements
  d'instantanés tolèrent les modifications concurrentes, et la CI de publication partage une seule compilation de runtime
  multiplateforme avec des portes explicites pour Git et Computer Use.
- Studio préserve les brouillons par élément et rend l'édition des détails, la sélection et les
  interactions au clavier résistantes à la navigation. L'utilisation du contexte et les contrôles de
  dictée vocale rapportent aussi leur état courant de façon plus cohérente.
- La voie OpenAI OAuth laisse par défaut le préchauffage du prompt WebSocket désactivé,
  évitant une requête de préchauffage inutile sauf activation explicite.
- Terminal-Bench 2.1 publie la comparaison complète `k=5` avec Codex CLI, avec les artefacts Harbor bruts,
  la vérification du commit source, la provenance des coûts récupérés et
  une génération de rapport reproductible.

## v0.9.157 - 2026-08-31

- Browser Use gagne une scission d'hôte plus petite et plus fiable entre onglets, téléchargements,
  interception, permissions, instantanés, rapports de boîtes de dialogue et cycle de vie des pages.
  L'import de profil Chromium inclut désormais le déchiffrement hors ligne des cookies App-Bound v20
  via l'importateur natif empaqueté, sans exposer les secrets déchiffrés au
  moteur de rendu ni à l'agent.
- Computer Use est décomposé en modules bornés de capture, découverte, ciblage,
  observation, saisie et worker. Une propriété des ressources plus équitable, un état
  post-action plus frais, des protections de saisie plus strictes et des scénarios de répétition élargis rendent
  les sessions natives et Chromium de longue durée plus rapides et plus sûres.
- La mémoire passe à un runtime d'embedding E5 compact avec rattrapage incrémentiel
  du plus récent au plus ancien, compression et rétention du cache, classement lexical adapté au coréen et
  récupération des workers inactifs. L'ancien addon natif de jetons et le chemin de modèle hérité,
  plus lourd, sont retirés du runtime livré.
- La récupération de session promeut le journal de points de contrôle en frontière de reprise
  durable, préservant l'utilisation du fournisseur, les ancres de compactage, la remise du rappel et
  la relecture de réflexion d'Anthropic à travers interruption, nouvelle tentative et redémarrage sans
  dupliquer le contexte.
- La création Office ajoute des plans de composition rédigés par le modèle, une bibliothèque de conception
  réutilisable, un aperçu de document, et des primitives Word, Excel et PowerPoint portables plus larges,
  tout en conservant les contrôles d'assurance structurels et rendus.
- Les surfaces web de bureau et mobiles gagnent Browser Use distant, la réception de partage,
  les notifications push, une édition et un aperçu de documents plus riches, une restauration au démarrage plus discrète
  et des mises à jour du cache du service worker plus prévisibles.
- La recherche native borne désormais les baux d'inventaire larges et admet équitablement les travaux
  find, glob et grep concurrents. L'automatisation de publication recompile de façon incrémentielle les ressources
  natives et vocales modifiées, vérifie les sidecars empaquetés et réutilise les artefacts de runtime de plateforme
  inchangés.

## v0.9.156 - 2026-08-29

- La création Office portable gagne le rendu de graphiques et les métriques de texte, de sorte que davantage de
  travaux PPTX et XLSX se terminent sans passer la main à l'hôte COM d'Office.
- Les contrats des outils Browser Use et Computer Use sont révisés en même temps que le
  magasin de réglages du bureau, la validation IPC et le formatage des outils dans la transcription.
- Le défilement virtuel du bureau suit désormais les paquets amont, et l'ancrage en bas
  de la transcription s'appuie sur le report de défilement propre au cœur.
- Les déploiements de développement peuvent s'exécuter depuis un instantané figé de l'arbre de travail
  (`update:dev:snapshot`), ce qui permet à une installation de réussir pendant que d'autres sessions
  continuent à modifier le dépôt au lieu d'échouer à la vérification de l'empreinte des entrées.

## v0.9.155 - 2026-08-29

- L'import de diapositives PPTX, le remplacement d'images et la création de données de tableaux s'exécutent désormais dans le
  moteur portable, de sorte que ces opérations n'exigent plus l'hôte COM d'Office.
- La création Office gagne des modules portables d'empaquetage, de composition, de style de feuille et
  de formes de diapositives derrière le pipeline d'assurance et de qualité existant.
- Le suivi des Objectifs gagne la gestion des rappels et de l'extraction de texte pour les poursuites,
  et le bureau garde les métadonnées de session synchronisées avec un budget de cache du moteur de rendu borné
  pour l'état des sessions non lues.

## v0.9.154 - 2026-08-29

- Les sessions Computer Use sont récupérées sur chaque chemin de sortie au lieu de dépendre d'
  un minuteur unref'd qu'un runtime en partance ne déclenche jamais : l'arrêt du démon et des workers
  les libère, une session qui se ferme libère la sienne, les workers d'hôte inactifs expirent
  sur la même horloge que les revendications de fenêtre qu'ils détiennent, et une connexion client abandonnée
  interrompt la saisie en cours au lieu de la laisser piloter le bureau jusqu'au
  délai de la commande. Le client réessaie aussi une fois auprès d'un pont republié, de sorte que
  le redémarrage de l'application de bureau ne fait plus échouer d'emblée la commande suivante.
- Une page Browser Use plantée se rétablit à la commande suivante au lieu de la faire échouer.
  Les refs liées au document mort sont abandonnées avec lui, de sorte que la récupération ne peut jamais
  renvoyer des coordonnées d'une page qui n'existe plus.
- Le compactage qui s'exécute entre une invite et la requête au fournisseur ne se bloque plus
  quand le runtime de mémoire cale : l'appel mémoire recall-fasttrack est borné pour
  chaque appelant, et pas seulement pour le seul chemin où un délai avait été câblé.
- L'analyseur d'entrées masquées de l'Explorateur Windows découpe la sortie d'attrib.exe avec les règles
  de chemins Windows sur n'importe quel hôte, et la sonde de capacité des hooks de commit fonctionne désormais avec
  les versions de git qui divergent sur la nécessité d'un indicateur pour un nom de hook non natif.
- Deploy cesse de recompiler des runtimes de plateforme identiques à l'octet près. Les sources de test quittent
  à la fois le paquet publié et la clé de cache du runtime, de sorte qu'une modification limitée aux tests
  atteint le cache de runtime préparé au lieu de payer une recompilation Windows de sept minutes. Les suites de bureau
  s'exécutent comme jobs de porte parallèles, dont une voie Windows qui exerce enfin
  Computer Use en CI, et la suite git de 240 secondes ne figure plus dans l'exécution locale par défaut.

## v0.9.153 - 2026-08-28

- Computer Use sous Windows exécute désormais une boucle d'observation plus petite de type CUA : une
  accessibilité compacte et une capture d'écran simple sont renvoyées ensemble par défaut,
  l'état post-action est rafraîchi immédiatement, AX et l'OCR de repli partagent un seul
  budget d'éléments strict, les captures noires, blanches ou incohérentes inutilisables n'émettent jamais
  de repère de coordonnées, les mutations invalident les repères de pixels précédents, une nouvelle
  fenêtre contextuelle du même processus devient la cible de vérification déterministe, les champs de texte
  Electron appartenant à l'application utilisent l'insertion en arrière-plan native du moteur de rendu, la récupération nomme
  un seul échelon d'escalade suivant, et les touches dangereuses de fin de session, les charges utiles shell
  ou les lancements d'hôtes shell/script sont bloqués à la frontière de l'hôte. Un tableau de bord Windows de 23 scénarios couvre désormais les chemins
  natifs, Electron, Chrome, OCR coréen, écran secondaire, état périmé, focus,
  fenêtre contextuelle, sécurité et nettoyage.
- Les observations et tours de Computer Use sont plus rapides sans affaiblir la frontière de saisie :
  des instantanés Win32 légers de transition/trame, la capture exacte de la fenêtre,
  une accessibilité Chromium moderne bornée, une interrogation de lancement adaptative, des protections de ressources de capture
  et une récupération vérifiée du focus/curseur remplacent l'énumération complète répétée des applications
  et les replis non bornés. La saisie littérale ciblée sur un élément peut
  donner le focus et saisir en une seule action, et l'OCR borné peut être inclus dans la capture
  post-action obligatoire. La matrice finale de 23 scénarios × 10 hôtes sources a atteint
  230/230 réussites sémantiques et réduit de
  90,55 %/94,01 % la latence p50/p95 de référence des scénarios ; une matrice de contrainte distincte (dense/minimisé/cible périmée) a réussi
  40/40. Les 30 recaptures post-action redondantes ont été supprimées, et les appels ont baissé de
  36,84 % dans les cinq workflows d'actions regroupables. Le regroupement de mutations arbitraires
  reste non pris en charge.
- Computer Use expose désormais un seul contrat strict de 15 actions au lieu de 28
  actions qui se chevauchaient ou d'un schéma plat à champs facultatifs. Observation/recherche/zoom
  utilisent `capture`, le cycle de vie des fenêtres et du presse-papiers utilise des champs d'opération, et un seul
  objet `capture_after` partagé configure la vérification automatique. Les consignes alignées sur les références
  exigent des cibles exactes fraîches, préfèrent les éléments sémantiques,
  et gardent Browser Use séparé. Le schéma final comptait 2 644 jetons estimés
  avant les extensions de pointe ; le contrat de pointe d'avant le retrait a réussi
  36/36 scénarios de modèle au premier appel. Le contrat de répartition directe actuel
  compte 3 210 jetons estimés et 14 485 octets sur le réseau. `diagnose`, en lecture
  seule, rapporte l'état de préparation de l'OCR/UIA Windows sans pixels d'écran ; `sequence` borné
  s'arrête sur échec ou transition de cible et renvoie un seul état final frais ;
  une cardinalité d'appels stricte empêche les mutations parallèles entre cibles, à la fois
  dans les consignes du modèle et avant la répartition anticipée du runtime. Les appels `computer`
  supplémentaires du même tour ne sont pas exécutés et reçoivent une erreur de récupération avec état frais.
  La sélection en langage naturel a réussi 4/4 chaînes de focus sûres et 4/4 frontières
  de transition. Sur 10 répétitions, une poursuite de deux actions a utilisé 50 % d'appels
  et de captures en moins côté modèle, avec une latence p50/p95 en baisse de 12,34 %/32,31 %.
  Les invites de confirmation de Computer Use et d'approbation de transaction Office côté modèle
  ont été supprimées ; les actions demandées par l'utilisateur s'exécutent désormais directement tandis que
  les motifs de touches, de charges utiles et d'hôtes de script bloqués restent des erreurs fermes.
  L'utilisation mesurée du fournisseur est de 5 150 jetons d'entrée et 4 026 ms p50 par appel
  de modèle. Un schéma post-observation à 12 actions a réduit l'entrée de 18,16 % avec
  27/27 de précision mais a été rejeté parce que des valeurs aberrantes de latence répétées et
  des changements de schéma en cours de boucle briseraient le contrat de cache de préfixe immuable du fournisseur.
  Les actions sémantiques avec des transitions de fenêtre exacte déterministes rapportent désormais
  une vérification confirmée. Aucun repli sur l'ancienne forme d'appel ne subsiste. Après un
  déploiement de développement, la validation de l'application installée a confirmé que le
  `click(ref)` gauche utilise l'activation sémantique et qu'un lancement natif par association de fichier
  renvoie sa cible sélectionnée avec un état frais ; les marques et les coordonnées
  restent des opérations de pointeur explicites.
- Browser Use peut importer les mots de passe, cookies et l'historique de Chromium, ne suggérer que des comptes
  masqués pour l'origine HTTPS courante, et remplir un formulaire de connexion sélectionné
  dans un monde CDP isolé sans exposer le mot de passe stocké au
  moteur de rendu, à l'agent, aux diagnostics ni aux journaux. Utilitaires utilise désormais par défaut le premier
  onglet de droite, migre l'ancien emplacement par défaut sans réinitialiser les dispositions
  personnalisées, et inclut le point d'entrée du navigateur.
- FastDirect calcule désormais l'empreinte, prépare, sauvegarde et restaure atomiquement les
  sidecars natifs d'import du navigateur avec `runtime.asar`, de sorte que les mises à jour
  de développement incrémentielles ne peuvent pas laisser l'application installée sans son importateur.
- L'utilisation du contexte de session enregistre désormais un instantané canonique postérieur au compactage qui
  survit à la persistance et au redémarrage jusqu'à ce que le tour suivant l'invalide. L'état de l'Objectif
  et la récupération du compactage restent cohérents d'un redémarrage de services à l'autre
  au lieu de repeindre une utilisation de jetons périmée ou de perdre un travail reprenable.
- La génération Office partage désormais un modèle de contenu sémantique, des contrôles d'assurance structurels
  et rendus, une revue d'injection de prompt, des portes de liste de contrôle et un pipeline de
  finition pour Word, Excel et PowerPoint. Les contrôles de page/vue des feuilles de calcul, la sélection de la capacité
  des modèles, la persistance native des données de graphiques et la vérification en direct d'enregistrement et de réouverture
  renforcent les documents de qualité de publication.

## v0.9.152 - 2026-08-27

- Le mode Objectif peut désormais porter un objectif de longue durée sur plusieurs tours avec des
  conditions d'achèvement durables, des contrôles de pause et de reprise, des limites de temps, une poursuite
  automatique, des outils de gestion destinés au modèle et un îlot d'état du bureau
  limité à la session.
- Browser Use et Computer Use sous Windows sont disponibles comme fonctionnalités intégrées
  facultatives. Browser Use peut inspecter et manipuler des pages dans l'application ou en arrière-plan,
  tandis que Computer Use combine UI Automation, captures d'écran, clavier, pointeur,
  défilement et actions de fenêtre avec une saisie tenant compte du DPI et des protections de sécurité.
- La récupération du fournisseur préserve désormais l'ordre d'origine du raisonnement, du texte et
  des appels d'outils sur les flux Anthropic, Gemini, OpenAI et compatibles, y compris les
  nouvelles tentatives, tours bloqués, sessions enregistrées, projection distante et compactage.
- Le compactage démarre une nouvelle époque de cache de lecture après avoir modifié la transcription,
  et les sessions existantes synchronisent les outils de runtime nouvellement disponibles aux frontières
  de tour au lieu de garder un catalogue d'outils périmé.
- La navigation du bureau et du mobile est plus claire et plus prévisible : les
  relancements mobiles repartent d'une seule Nouvelle tâche tandis que les reconnexions conservent les volets courants,
  les balayages de volets fonctionnent sur le contenu riche et les superpositions, et les pages latérales, extensions,
  le Markdown, les libellés d'état et les actions de fin de ligne partagent des dispositions réactives plus serrées.

## v0.9.151 - 2026-08-26

- Modifier un lien symbolique modifie désormais le fichier vers lequel il pointe au lieu d'être
  refusé : patch et edit suivent le lien dans tous les moteurs, écrivent
  atomiquement à côté de la vraie cible, et laissent le lien lui-même intact.
- Les exécutions sans interface et de banc d'essai ne laissent plus de bases de données et de processus
  temporaires derrière elles. Chaque exécution reçoit une racine de runtime isolée, l'arrêt attend le démon
  de session au lieu de signaler un succès avant lui, et les clusters orphelins sont
  balayés à la sortie.
- Le compactage de conversation conserve tout ce qu'il doit. Les compactages automatique, manuel et
  effacé partagent un seul chemin, le résumé stocké est en tête avec l'historique brut complet
  derrière lui, et les tours les plus récents survivent verbatim au lieu d'être
  tronqués par un plafond de lignes ou de taille.
- L'exploration lit le fichier d'origine avant de décider comment l'analyser, le compter ou
  le résumer, de sorte qu'une supposition de format ne dicte plus la réponse.
- Finitions du bureau : les images jointes s'ouvrent dans la visionneuse du système, les lignes de quota
  du panneau d'utilisation se lisent dans un ordre naturel, et les panneaux de contexte et de route perdent
  leurs cadres résiduels et leurs contours de focus.
- Les résultats de Terminal-Bench 2.1 sont republiés à partir d'une exécution `k=5` des 89 tâches,
  avec les artefacts bruts de vérification de chaque exécution publiée versionnés
  aux côtés du harnais et des scripts de métriques.

## v0.9.150 - 2026-08-25

- Les résultats d'outils restent faciles à parcourir et honnêtes sur leur taille : la sortie de recherche et
  les lectures multi-fichiers respectent un budget fixe au lieu d'inonder une réponse avec
  des milliers de lignes, et un chemin qui n'existe simplement pas — ou un verdict ordinaire
  sur l'état du dépôt — revient comme la réponse plutôt que comme un échec
  qui envoie l'assistant en récupération.
- Les sessions ne portent plus d'empreinte de fournisseur périmée à travers un redémarrage, et un
  nouveau message réveille immédiatement un tour qui attend une tâche d'arrière-plan, de sorte
  qu'une réponse arrive au lieu de rester derrière l'attente.
- La sélection de texte du terminal se rétablit après un glisser dont le bouton a été relâché
  hors de la fenêtre, et une sélection glissée au-delà du bord haut ou bas
  suit le comportement normal de début et de fin de ligne au lieu de se figer à
  la dernière colonne tenue par le pointeur.
- La dictée vocale demande confirmation avant d'installer son runtime, les cartes d'outils
  et les cadres de diff s'alignent sur le thème partagé, et dix langues d'interface
  sont rafraîchies.

## v0.9.149 - 2026-08-24

- Les sessions OpenAI OAuth parlent désormais par défaut la forme de protocole du client de référence :
  identité stable d'installation et de fil, forme de requête plus légère sur les modèles
  actuels, et gestion conforme au fournisseur d'un socket qui atteint sa limite de durée de vie
  en cours de session.
- Le démarrage de session réserve sa connexion préchauffée au premier tour uniquement
  quand le prompt qu'elle a préchauffé correspond toujours, de sorte qu'un tour dont l'environnement ou la surface
  d'outils a changé démarre à neuf au lieu de renvoyer toute la requête.
- Les listages de répertoires renvoient une première page dimensionnée pour le parcours plutôt qu'un vidage,
  et les recherches de structure de code ne récupèrent les corps complets de symboles que lorsque l'implémentation
  exacte est nécessaire.

## v0.9.148 - 2026-08-24

- Les conversations de bureau et mobiles préservent plus fiablement les brouillons, l'historique, le comportement de suivi,
  les gestes de volets et l'état distant, tout en réduisant les transferts du relais
  et la charge de déploiement du moteur de rendu.
- Les sessions d'agents récupèrent plus cohérentment les flux du fournisseur, le compactage, l'état des workers et les
  résultats d'outils, avec des issues de conflits Git et d'environnement plus claires et une
  télémétrie de recherche plus précise.
- La saisie vocale gagne un chemin de publication de runtime multiplateforme vérifié, tandis que
  la récupération de mémoire, la gestion des processus natifs et la préparation du runtime empaqueté
  sont renforcées.
- L'automatisation de publication, le déploiement FastDirect et les rapports de banc d'essai réutilisent désormais les
  artefacts inchangés et comparent les appels de modèle, le coût et le contexte final avec
  une comptabilité conforme au fournisseur.

## v0.9.147 - 2026-08-21

- Les longues sessions OpenAI conservent désormais intacts leur chaîne de réponses et l'épinglage de l'état du tour
  à travers les reconnexions, les réordonnancements d'éléments et le compactage, de sorte que le cache de préfixe du fournisseur
  survit à une session au lieu de redémarrer en pleine tâche.
- Le démarrage de session préchauffe le préfixe du fournisseur et sépare les détails
  d'environnement du préfixe d'instructions partagé, réduisant les démarrages à froid et le
  téléversement répété d'un contexte identique.
- Les règles d'usage des outils se lisent plus court avec les mêmes garanties : les clauses de routage
  disparaissent désormais avec les outils qu'elles nomment, et les résultats shell sont classés par
  l'exécuteur qui les a produits.
- Les cartes d'outils et résumés de résultats du bureau sont localisés, et la jauge de contexte
  indique l'estimation postérieure au compactage au lieu du préfixe écarté.
- Les exécutions de banc d'essai gagnent des préréglages de routes rapides et un adaptateur de référence CLI grok,
  de sorte que les chiffres de référence proviennent des mêmes conteneurs et du même vérificateur.

## v0.9.146 - 2026-08-21

- Les conversations web mobiles gardent désormais stables le défilement tactile, la mesure du Markdown
  en streaming, les balayages d'onglets, les contrôles compacts du compositeur et les superpositions réactives
  à travers les gestes natifs, la rotation et les dispositions de petit écran.
- Les sessions peuvent transporter une conversation complète vers le modèle actuellement sélectionné
  lorsqu'elle tient dans la limite de contexte de ce modèle, tandis que l'utilisation du contexte et les
  détails de route hérités restent explicites.
- Les groupes d'outils de la transcription préservent leurs appels, arguments, sorties et état
  d'achèvement d'origine pour une inspection détaillée, avec des aperçus d'images localisés et
  une présentation de l'activité plus claire.

## v0.9.145 - 2026-08-21

- Les sessions web mobiles gardent désormais stables l'échelle native de la fenêtre d'affichage, la récupération d'appairage,
  la projection de l'état distant et le défilement de la transcription à travers les gestes tactiles,
  les mesures de lignes en streaming, les restaurations d'application et les connexions lentes.
- Les volets du bureau, les rafraîchissements du contrôle de source, l'activité des outils, les surfaces de commandes et
  l'état des sessions se rétablissent plus cohérentment tout en préservant des dispositions réactives
  et des retours de chargement ou d'interruption plus clairs.
- Le routage des outils d'agent applique désormais des protections d'arguments plus strictes, une politique de mutation Git,
  la gestion du préfixe du fournisseur, la projection des preuves et la récupération de sortie shell
  dans le runtime partagé et la TUI.
- Les outils de publication, de banc d'essai, de localisation et de diagnostic valident désormais leurs
  contrats avec une couverture de non-régression plus large et des rapports de runtime plus compacts.

## v0.9.144 - 2026-08-21

- L'interaction du bureau suit désormais plus fidèlement le focus clavier et pointeur,
  améliore les balayages de volets mobiles et la présentation de la transcription et de l'état, et signale
  l'état des tâches shell d'arrière-plan avec une récupération plus sûre.
- Les volets de diff Git révèlent immédiatement leur propre état de chargement, fusionnent les
  rafraîchissements qui se chevauchent, et affichent le texte du dépôt sans invoquer les commandes
  diff externes ou textconv configurées.
- Solo est désormais le workflow par défaut, les règles d'usage des outils préservent les preuves tout en
  regroupant le travail plus étroitement, et les fenêtres read/grep bornées réduisent le contexte
  inutile sans masquer la pagination.

## v0.9.143 - 2026-08-20

- L'exécution des sessions partage désormais un seul worker de runtime supervisé au lieu d'un
  pool de fragments de processus. Les agents d'arrière-plan restent dans le processus, les attentes du fournisseur cèdent
  leur créneau local d'admission CPU, et les limites de lancement à l'échelle de la machine et la récupération de
  l'état de santé du runtime restent appliquées.
- Les approbations d'appareils distants n'apparaissent que lorsque Réglages → Connexion est ouvert,
  récupèrent les demandes en attente à l'ouverture de ce panneau, et ne se terminent qu'une fois que le
  navigateur a prouvé sa connexion E2EE authentifiée.

## v0.9.142 - 2026-08-20

- L'empaquetage du bureau Linux valide l'architecture cible dans le répertoire de prébuild ABI
  que `node-pty` charge réellement, tandis que les paquets Windows et
  macOS compilés conservent leur chemin de validation `build/Release`.

- Les applications web installées reprennent une approbation de bureau en attente à travers les rechargements, tandis que le
  bureau remplace les invites périmées, les fait expirer avec la requête du relais, et
  n'accepte chaque décision qu'après confirmation du service.
- FastDirect réutilise les cibles de compilation fraîches, un cache persistant du moteur de rendu de production,
  la sortie de runtime préparée et un modèle de coque ASAR extrait. Les déploiements en direct du relais
  calculent indépendamment l'empreinte des changements de moteur de rendu/serveur et ne téléversent
  que les deltas vérifiés du moteur de rendu avant l'échange atomique sur le VPS.
- Le code en ligne suit la police et la taille de la prose environnante, ne laissant que la couleur
  comme distinction en ligne tandis que le code délimité reste en chasse fixe.

## v0.9.141 - 2026-08-20

- La création de tâches du bureau fonctionne sous Electron 41 et Node 24 : le routeur de fragments d'agents
  copie désormais les exports ESM immuables du gestionnaire de sessions dans une façade modifiable avant
  d'installer ses remplacements de session distante.

## v0.9.140 - 2026-08-20

- Les suppressions dans Studio prennent effet dès le premier clic : une exécution terminée libère son
  emplacement de grille dès que son ressource est indexée, de sorte que la suppression de cette ressource ne
  ressuscite plus l'emplacement sous la forme d'une tuile fantôme « generating ». La galerie n'est plus
  plafonnée à 2 000 entrées — une ressource ne quitte le magasin que par une suppression explicite —
  et une exécution qui échoue, démarre sans tâche ou perd son instantané de runtime
  le signale désormais au lieu de tourner en silence.
- Le sélecteur d'onglets mobile se présente comme une grille de cartes et ne gagne un champ de filtre que
  lorsque la liste est assez longue pour en avoir besoin, tandis que l'habillage du téléphone reformule les
  disques du compositeur, l'îlot d'état et les feuilles de panneaux à des proportions tactiles et
  met à portée de main les contrôles qui n'apparaissaient qu'au survol.
- Une application web installée peut s'appairer elle-même : elle ouvre une URL d'entrée routée par appareil,
  demande l'approbation de ce bureau derrière un code à deux chiffres affiché sur les deux
  écrans, et reçoit le matériel d'appairage scellé pour sa propre clé jetable.
  Les navigateurs appairés enregistrent désormais les voies push qu'ils lisent, de sorte qu'un
  téléphone connecté ne paie plus le trafic de terminal, d'éditeur et de fichiers qu'il n'affiche jamais.
- Le serveur de recherche du graphe de code sert les clients à tube partagé avec des files de
  réponses par connexion et des identifiants de requête propres au client, et se termine de lui-même après
  une fenêtre d'inactivité afin qu'un propriétaire tué de force cesse de laisser des serveurs chauds derrière lui.
- Les appels d'outils survivent au bruit des arguments du fournisseur : un chemin de base facultatif omis
  se résout vers le Projet courant au lieu de faire échouer l'appel, les arguments des tâches
  sont restreints à l'action choisie, et la sortie de git conserve sa dernière trame de progression
  et sa ligne fatale finale au lieu d'enfouir la raison sous des trames de redessin.
- Le moteur de rendu charge un seul catalogue de langue d'interface au lieu de onze, fixe la
  langue avant l'évaluation du premier module de l'application, et précharge un fragment de surface à la sélection ; /inherit transporte une conversation existante vers une nouvelle
  session sur la route actuellement sélectionnée.
- Les crédits aux tiers sont portés par LICENSES et NOTICE uniquement.

## v0.9.139 - 2026-08-20

- Antigravity OAuth arrive comme fournisseur : une seule connexion Google expose Gemini 3.x
  et Claude via la passerelle Cloud Code Assist, avec connexion, renouvellement de jeton
  et basculement de point de terminaison suivant la forme existante des fournisseurs OAuth.
- Les agents n'ont désormais que deux états, un modèle épinglé ou désactivé, et Recherche web
  résout le Modèle principal lorsque sa route n'est pas définie.
- Les navigateurs appairés accèdent à la surface d'opérations du bureau — instructions de projet,
  navigation dans les dossiers et emplacements, et contrat git — via un seul module partagé de
  validation des arguments, tandis que l'état de session du relais voyage sous forme de deltas
  compacts propres au client dans des trames E2EE binaires.
- L'application web livre désormais des ressources brotli et gzip précompressées, retient les
  préchauffages d'arrière-plan et les polices sur les liaisons limitées ou lentes, redimensionne les pièces jointes d'images
  et l'audio de dictée avant téléversement, abandonne le flou en direct de l'îlot d'état épinglé
  sur les téléphones, et peint l'accent de la marque en bleu Google.
- La préparation du runtime Windows et l'empaquetage asar survivent aux scripts de cycle de vie du dépôt
  et aux verrous de fichiers transitoires de l'antivirus, et la ligne d'état de la TUI calcule directement
  son nombre de shells en cours sur le chemin instantané.

## v0.9.138 - 2026-08-19

- Les sessions web distantes utilisent désormais des abonnements propres au client, des trames E2EE binaires,
  des deltas compacts d'état/catalogue, le regroupement du terminal et des sondes de latence de rendu,
  réduisant le volume transféré tout en préservant la récupération en direct sur les liaisons lentes.
- Le défilement de la transcription web et la saisie du compositeur restent visuellement stables pendant
  des instantanés distants concurrents, des changements de session et le rendu mobile.
- Le contexte du runtime, la récupération des requêtes au fournisseur, les notifications de tâches d'arrière-plan
  et la restauration de l'achèvement sont renforcés sur les sessions de longue durée.

## v0.9.137 - 2026-08-19

- La récupération de reconnexion distante rafraîchit désormais les catalogues de sessions et les voies de
  transcription montées, et le contrôle de mise à jour ouvre le groupe de boutons de la barre de titre.

## v0.9.136 - 2026-08-19

- La messagerie Discord/Telegram retirée et la plomberie des sessions de canaux sont supprimées,
  tandis que les barres système mobiles restent systématiquement noires.

## v0.9.135 - 2026-08-18

- Le bureau préserve désormais les dispositions de volets, l'état de la barre latérale, la géométrie des panneaux et
  les brouillons du compositeur à travers les rechargements et les redémarrages FastDirect, avec une couverture de
  non-régression du moteur de rendu élargie.
- L'exécution du shell renforce désormais le nettoyage de l'environnement, la veille à chaud, la récupération de
  l'achèvement en arrière-plan, la gestion des processus natifs et le routage des outils dans les sessions
  interactives et sans interface.
- Les versions Linux de spawn natif sont liées statiquement, la recherche de graphe et les rapports de rappel
  sont renforcés, et le routage de Terminal Bench ainsi que les outils de rapport sont
  mis à jour.

## v0.9.134 - 2026-08-17

- Le bureau livre désormais la marque choisie, un éditeur unifié de routes de modèles avec
  paramètres de modèle et ordre de liste persistant, et déballe node-pty à côté du
  démon empaqueté.
- Le compactage de session est verrouillé par propriétaire : les sessions d'agents restent sémantiques,
  les sessions utilisateur utilisent recall-fasttrack. Les Réglages ne listent plus les Core memories
  (elles vivent sur le projet), et l'inventaire de recette Windows correspond.

- Les intégrations de fournisseurs et d'outils incluent désormais le cycle de vie OAuth et la récupération de jetons
  pour Anthropic, Cursor, Grok et OpenAI, la normalisation des schémas d'outils propre à Grok, et
  un éclatement décomposé des chemins/motifs de search et grep.
- L'orchestration des sessions et les workflows de la TUI appliquent désormais la portée par session propriétaire,
  préservent les cartes de remise terminée et d'achèvement en arrière-plan à travers les restaurations,
  conservent les invites en file d'attente externalisées, et classent les issues entre échecs
  de commandes, erreurs d'outils et absences bénignes.
- La navigation de l'espace de travail du bureau préserve désormais les titres de sessions des volets pendant les
  glisser-déposer, ajoute des nouvelles tentatives de restauration d'espace de travail à froid qui empêchent la perte
  d'onglets, et met à jour les panneaux d'accueil et de configuration des capacités.

## v0.9.133 - 2026-08-16

- La projection de preuves réservée au fournisseur donne désormais des alias aux chemins de fichiers typés répétés
  au sein des époques de mutation, préservant les enveloppes d'outils exactes et les chemins
  reconstructibles tout en réduisant le contexte cumulé dans les longues sessions.
- L'exécution de Git partage désormais une seule politique de mutation entre l'orchestration et
  la projection de preuves, sérialise les écritures à l'échelle du dépôt par rapport aux modifications de fichiers,
  utilise des processus natifs propriétaires de l'arbre, et rend les verrous en file d'attente interruptibles.

## v0.9.132 - 2026-08-16

- L'exécution des outils expose désormais le statut de sortie complet du shell, ajoute une surface
  Git dédiée, renforce la création atomique de patchs et les diagnostics, et améliore
  l'intégrité de la recherche, du listage, du code-graph et du graphe natif sous charge concurrente.
- Le compactage de session, la récupération des fournisseurs/images, le suivi des preuves, la santé des fragments
  et le nettoyage du runtime de Lead préservent désormais l'état en cas d'échec sans masquer
  les workers dégradés ni déclencher de travail de repli inutile.
- Le routage du bureau, l'activité des agents, l'état restauré des volets et le rendu du Markdown
  en streaming restent désormais réactifs et visuellement cohérents entre conversations en direct et
  reprises.

## v0.9.131 - 2026-08-14

- Les portes de publication s'exécutent désormais automatiquement avec une sélection incrémentielle des chemins, les runtimes
  de plateforme du bureau se préparent avant l'empaquetage, les compilations du graphe natif utilisent un
  profil reproductible plus rapide, et le déploiement web/relais de production inclut
  un retour arrière atomique ainsi qu'une vérification des empreintes et de l'état de santé.
- Les voies de publication du bureau empaquettent désormais dès que leur runtime correspondant est prêt,
  les caches du compilateur de graphe restent isolés entre les compilations de reproductibilité, les installations du relais
  sont figées par fichier de verrouillage, et le chronométrage des publications avertit des régressions de 10 %.
- Le nettoyage des agents ne confond plus les projections du pool de Lead avec des workers enfants, de sorte
  que la libération d'un autre runtime ne peut pas fermer la conversation de bureau active ni
  écarter un message de suivi accepté.

## v0.9.130 - 2026-08-14

- La récupération des fournisseurs et des sessions classe désormais les échecs de flux transitoires
  de façon cohérente, retente les tours rejetés pour image sans perdre l'intention de l'utilisateur, et
  préserve l'interruption, le résumé et l'état du résultat terminal à travers les transports
  Gemini et OpenAI.
- Les échecs d'outils sont persistés sans pollution par les traces de test, la politique shell évite les
  faux positifs sur les scripts entre guillemets, et les chemins natifs de recherche/lecture/listage/stat partagent
  un travail annulable tout en préservant l'invalidation fraîche des observateurs et le comportement exact
  de grep/glob sur fichier sous charge.
- Studio, l'utilisation, l'activité des agents, la disposition des volets, la localisation et la présentation des étiquettes
  de workers du bureau restent désormais alignés entre sessions restaurées et en direct.

## v0.9.129 - 2026-08-14

- L'exécution sans interface (exec) lance désormais par défaut une véritable surface solo : les outils de recherche web et de
  mémoire restent désactivés sauf si --web-search / --memory les réactivent, les processus enfants
  du shell héritent d'un proxy sans sortie imposé (la boucle locale reste
  accessible), et la ligne d'environnement de session indique network=offline afin que
  les modèles ne tentent jamais d'accéder au web.

## v0.9.128 - 2026-08-14

- Les outils d'exploration se terminent désormais au tour de recherche : grep consacre son budget de sortie
  à des blocs de source classés (correspondances de branches rares d'abord), find écarte les
  résultats flous composés uniquement de bruit, et les plans de symboles de code_graph filtrent avant
  de plafonner et respectent les demandes de corps.
- Les consignes aux agents regroupent un appel le mieux routé par inconnue au lieu d'un
  éclatement spéculatif multi-outils, réduisant d'un tiers l'usage de jetons du banc d'essai sans
  changement du taux de réussite.
- Renforcement de la récupération de session et de la résilience du runtime pour la recherche native,
  le contrat du shell et les outils read/list.

## v0.9.127 - 2026-08-14

- Les binaires natifs ont désormais un foyer canonique unique dans les GitHub Releases : npm ne livre
  que la CLI, tandis que les exécutions de la CLI vérifient et mettent en cache les ressources à la demande et que les
  versions de bureau embarquent les mêmes ressources de plateforme vérifiées.

## v0.9.126 - 2026-08-14

- La recherche native gère désormais l'intégralité du contrat interne grep/find, préserve
  les erreurs de récupération de regex, et fait chevaucher le préchauffage de la recherche du premier tour et du code-graph.

## v0.9.125 - 2026-08-13

- L'exécution du shell et des tâches d'arrière-plan utilise désormais un seul gestionnaire de processus natif épinglé par hachage
  sur Windows, Linux et macOS, sans repli sur l'environnement, une compilation locale, le
  registre de fichiers, un shell en veille ni un processus Node.
- Les chemins natifs de recherche, patch, téléchargement, médias, rappel, webhook et session
  appliquent désormais des ressources bornées, une propriété plus stricte, et des vérifications renforcées du transport
  et de la chaîne d'approvisionnement des publications.
- L'extraction du runtime de mémoire accepte désormais les liens vérifiés internes à l'archive tout en
  rejetant les traversées, les liens externes et les entrées tar spéciales.
- Le comportement du projet, du terminal, des mises à jour, de l'appairage distant, du relais et des volets du bureau
  inclut désormais les correctifs consolidés de sécurité, de récupération et de disposition réactive.

## v0.9.124 - 2026-08-12

- L'activité des agents du bureau regroupe désormais chaque session active indépendamment de
  l'onglet actif, tandis que les volets de sessions restaurés se préchauffent correctement et que les sessions existantes
  acceptent la saisie de suivi sans attendre l'accusé de réception de l'hôte.
- Le transport des sessions du bureau et du démon survit désormais aux courses au démarrage, aux
  sessions de contrôle périmées, aux pertes transitoires de socket et à la récupération de flux sur place, tout
  en gardant la propriété distante globale lors des changements de focus de session.
- Les préférences de commit Git séparent désormais l'exemple visible des instructions IA,
  sérialisent les enregistrements qui se chevauchent, et valident puis corrigent la sortie Conventional Commit
  avant de l'accepter.
- La mémoire centrale reflète désormais le contexte organisé et généré dans un fichier atomique
  protégé par révision, afin que les sessions puissent charger la mémoire ciblée sans démarrer à froid
  le runtime de mémoire, les mutations rafraîchissant le miroir.
- L'ancrage de la transcription de la TUI et la gestion de la sélection par Échap évitent les sauts visuels et
  la restauration accidentelle de la file, tandis que le repli sur refus de Terminal-Bench suit
  la raison de terminaison du runtime même après une narration en streaming.

## v0.9.123 - 2026-08-12

- La configuration des fournisseurs du bureau récupère désormais les sessions de contrôle périmées sans exposer
  les échecs de transport bruts, et l'historique des invites ne s'engage qu'à partir d'un brouillon vide.
- La recherche de chemins évite les balayages complets à froid de l'arborescence, fusionne les préchauffages d'observateurs, et
  resserre les échéances de la recherche native, la concurrence en masse et les instantanés de processus.
- Les consignes sur le délai d'expiration asynchrone du shell distinguent désormais le travail d'arrière-plan illimité
  des échéances d'arrêt explicites.

## v0.9.122 - 2026-08-11

- Les règles de routage des outils centralisent désormais les conventions de chemins, suppriment les consignes
  de regroupement en double, et n'exigent une inspection en lecture seule que lorsque les preuves sont menacées.
- La vérification préalable du banc d'essai Anthropic résout désormais correctement les imports de fournisseurs depuis
  des instantanés temporaires isolés du harnais.

## v0.9.121 - 2026-08-11

- Les règles d'exécution des outils et les diagnostics du shell distinguent désormais les absences
  de chemin concluantes, font confiance aux enveloppes vérifiées, conservent les vérifications de valeur dans le même tour, et font ressortir
  les faits de commande introuvable issus de stderr.
- La virtualisation de la transcription du bureau épingle désormais les extrémités de la sélection de texte native
  pendant le défilement automatique lors d'un glisser, tandis que les lanceurs d'utilitaires alignent leur icône et leur texte
  dans des lignes dimensionnées selon le contenu.

## v0.9.120 - 2026-08-11

- Les tâches shell d'arrière-plan conservent désormais leur session propriétaire et leur démon après que chaque
  vue s'est détachée, de sorte que l'éviction pour inactivité ne peut pas annuler la tâche avant la livraison
  de son achèvement.

## v0.9.119 - 2026-08-11

- Les compilations de reproductibilité de Native Graph et Token s'exécutent désormais sur des runners
  indépendants en parallèle, tandis que les téléversements DMG et ZIP pour macOS Intel se chevauchent et abandonnent
  rapidement les transferts bloqués.
- La navigation des projets du bureau, les surfaces d'utilitaires, le focus de la transcription et le comportement de la
  virtualisation intégrée sont affinés, avec des styles d'exécution d'outils plus serrés
  et une réutilisation des processus du système de fichiers.
- La gestion des pièces jointes Discord et Telegram préserve la livraison de médias bornée
  et valide directement le comportement des téléversements Telegram.

## v0.9.118 - 2026-08-11

- Le bureau regroupe Agents, Recherche et Contrôle de source dans le dock d'utilitaires,
  garde Utilitaires sélectionné pendant le lancement des outils, et aligne le traitement des avertissements et
  des échecs entre cartes d'outils restaurées et en direct.
- Le listage de fichiers et la recherche native fusionnent désormais les énumérations concurrentes, prennent en charge
  des requêtes persistantes annulables et des instantanés de processus, et préservent le comportement de
  repli borné sous une forte dispersion du système de fichiers.
- Le regroupement du code-graph, la réutilisation de la veille PowerShell, le suivi de l'arbre de processus du shell
  et l'invalidation des caches sont renforcés contre le travail concurrent et l'état périmé.

## v0.9.117 - 2026-08-11

- L'envoi d'invites du bureau prend désormais en charge la mise en file immédiate par Entrée et la restauration précise
  par Échap du texte et des pièces jointes en attente, tandis que le défilement de la transcription
  diffère les corrections du virtualiseur pendant le mouvement actif du lecteur.
- Utilitaires du bureau présente désormais des lanceurs directs Studio, Terminal et Explorateur
  avec des descriptions localisées, tandis que la barre d'activité utilise l'identité créative
  Utilitaires et une présentation de l'utilisation rafraîchie.
- Les actions de canaux obsolètes destinées au modèle et leur plomberie de répartition par fournisseur
  sont supprimées afin que le catalogue d'outils annoncé corresponde à la surface du runtime.
- Les consignes d'exécution des outils resserrent les preuves regroupées et la vérification dans le même tour,
  tandis que les salves concurrentes de système de fichiers, de graphe, de patch et de shell gagnent une gestion bornée
  des pools de threads, des voies de lancement et de la pression d'accessibilité.

## v0.9.116 - 2026-08-11

- L'analyse des tours H5 de Terminal-Bench ajoute des traces de tâches récompensées et des décomptes
  agrégés de tours pour la comparaison finale à effort élevé.

## v0.9.115 - 2026-08-11

- L'analyse des tours H4 de Terminal-Bench enregistre les sondes de tâches réussies à effort élevé
  et leur cadence de récupération, de patch et de vérification.
- Les consignes d'exécution des outils traitent désormais les faits de tâche et les vérifications prouvées comme un état connu
  durable et gardent la vérification du patch dans le même tour d'exécution.

## v0.9.114 - 2026-08-11

- Les identités d'outils devinées sont désormais vérifiées avant les appels dépendants, avec une analyse
  des tours H3 de Terminal-Bench enregistrant les motifs de récupération qui en résultent.

## v0.9.113 - 2026-08-11

- Les consignes sur les outils regroupent désormais des échantillons de preuves distincts et évitent les activations
  redondantes d'outils différés ou de projets, avec l'analyse des tours de Terminal-Bench
  capturant les motifs de sondes sérielles restants.

## v0.9.112 - 2026-08-11

- Les surfaces d'utilitaires, d'activité, de transcription, de réglages et de dépôt du bureau sont
  simplifiées autour d'une configuration ciblée des fonctionnalités et de régressions compactes.
- La récupération des fournisseurs, les diagnostics shell/listage et la vérification de publication sont
  consolidés en suites plus petites critiques pour la livraison sans affaiblir leurs contrats de
  transport, de ressources ou d'empaquetage.

## v0.9.111 - 2026-08-11

- La navigation dans le dépôt utilise désormais la surface directe des outils intégrés sans
  agent explorateur distinct, réduisant la charge de routage et la configuration héritée.
- Les décisions de nouvelle tentative WebSocket d'OpenAI préservent les erreurs actuelles d'authentification, de limitation de débit et
  d'annulation, tandis que la récupération du transport de session et la déduplication
  des achèvements sont renforcées.
- Le regroupement des outils, l'éclatement du graphe, les rapports de progression et le comportement de la transcription, des
  réglages et du dock d'utilitaires du bureau sont rationalisés avec des régressions ciblées.
- Les profils de Terminal-Bench 2.1, les exécutions reprenables, les instantanés immuables du harnais et
  la comptabilité des coûts sont resserrés pour des comparaisons natives reproductibles.

## v0.9.110 - 2026-08-11

- Les transports des fournisseurs bornent désormais les blocages non-streaming d'Anthropic, distinguent
  les échecs de transport réessayables des refus du modèle, préservent la continuité du raisonnement OpenAI
  lors de la récupération, et préchauffent les sessions WebSocket compatibles.
- Les outils patch, list et shell récupèrent en un appel les décalages uniques de chemin ou de contexte
  tout en conservant les protections contre l'ambiguïté, les liens symboliques et les commandes destructrices.
- La complétion des titres de session et la gestion du repli sur la source Markdown sont plus
  résilientes, avec des régressions ciblées sur le fournisseur, le moteur de rendu, les outils et le routage.
- Les diagnostics de Terminal-Bench 2.1, les références natives équitables, la comptabilité de l'utilisation et
  les expériences reproductibles de relecture du raisonnement sont étendus.

## v0.9.109 - 2026-08-10

- Les commandes shell qui se terminent avec un code non nul sont traitées comme des résultats de commande
  plutôt que comme des échecs d'outil, avec un statut cohérent dans le runtime et la TUI.
- Le routage des outils, les limites de l'explorateur, les contrats de styles de sortie et leurs suites de
  régression sont resserrés pour éviter le travail redondant tout en préservant des rapports concis
  destinés à l'utilisateur.
- Les racines de patch compactes établissent désormais à la fois la frontière d'écriture et le
  repère des chemins relatifs, avec des consignes de récupération plus claires.

## v0.9.108 - 2026-08-10

- L'analyse des patchs compacts accepte les enveloppes héritées Begin/End autour des sections
  compactes tout en laissant l'entrée V4A canonique inchangée.

## v0.9.107 - 2026-08-10

- Les sessions d'automatisation non interactives et de banc d'essai utilisent explicitement un contexte
  d'approbation implicite, tandis que les workflows interactifs conservent leur porte d'approbation utilisateur.

## v0.9.106 - 2026-08-10

- Les clients MCP, la découverte des outils, les instructions, l'exécution, le rafraîchissement différé et
  le démontage sont isolés par portée de runtime, de sorte que des serveurs de même nom ne peuvent pas fuir
  entre des sessions concurrentes ou des agents autonomes.

## v0.9.105 - 2026-08-10

- L'accès distant se fait uniquement par application web : le paquet Capacitor/Android retiré,
  les routes de téléchargement APK, les hooks de coque native et le câblage des versions de publication mobile
  sont supprimés, tandis que le déploiement du relais gagne une étape explicite de préparation du moteur de rendu.
- Les appels d'outils normalisent désormais les entrées du projet courant en chemins relatifs compacts,
  rejettent de façon cohérente les portées incohérentes ou redondantes, et préservent la parité
  entre les contrats des outils shell, patch, graph, explore et intégrés.
- Le rapport de contexte sépare l'utilisation visible du fournisseur de la pression de compactage
  et de la réserve configurée, tandis que la réflexion adaptative d'Anthropic laisse son mode d'affichage
  à l'API sauf remplacement explicite par un opérateur.
- Les brouillons de nouvelle tâche gardent leur propre onglet de projet lors de la sélection ou de l'enregistrement d'un
  projet, et les changements Fast de session réussis amorcent le prochain brouillon correspondant
  sans remplacer un choix de modèle différent.

## v0.9.104 - 2026-08-09

- Le routage des outils localise désormais une seule fois les coordonnées inconnues du dépôt, assigne chaque
  facette de preuve à un seul outil dédié, ne regroupe que les appels indépendants, et
  garde les modifications de texte et la vérification derrière la barrière d'exécution des patchs.
- L'inspection des répertoires expose les fichiers cachés et les métadonnées de fichiers sans exploration par
  Shell, tandis que les workflows sans délégation omettent le brief de Lead inutilisé et
  utilisent une surface d'outils plus petite et alignée sur les capacités.

## v0.9.103 - 2026-08-08

- La navigation du bureau, le compositeur, Studio, les réglages et les surfaces de transcription partagent désormais
  une disposition réactive plus serrée, avec un suivi du défilement virtuel renforcé, la
  gestion des fichiers locaux et une couverture de régression DOM élargie.
- Le moteur de rendu distant est livré comme application web installable avec un manifeste stable, une
  icône et un service worker réseau seul, tandis que le relais sert ces ressources
  avec les types de contenu requis pour le manifeste et le service worker.
- L'exécution Solo ne porte plus les définitions d'agents obsolètes de débogueur, de tâche de planificateur ou
  de gestionnaire de webhook et supprime leur protocole de routage/cache périmé, gardant les services
  intégrés séparés des agents personnalisés modifiables.
- La génération d'images Codex hébergée sélectionne explicitement l'outil d'image pour les modèles
  pris en charge, avec une couverture ciblée du corps de requête.

## v0.9.102 - 2026-08-08

- Incrément de version de maintenance ; aucun changement fonctionnel par rapport à la v0.9.101.

## v0.9.101 - 2026-08-08

- Échap rappelle désormais dans le compositeur les messages en file d'attente et non encore traités
  avant toute autre chose — dans l'ordre de la file — de sorte qu'un Échap en plein tour modifie le
  suivi en attente au lieu d'interrompre le tour ; une seconde pression annule toujours.
- Les workflows sont de pures définitions de style de travail : les packs ne portent plus de liste
  d'agents. Chaque agent défini (intégré et personnalisé) est disponible pour tout workflow
  délégant, Solo reste sans délégation via `delegation: none`, et la
  suppression d'un agent personnalisé le retire de toutes les surfaces à la fois, y compris
  du lancement par nom.
- Réglages → Général a gagné des interrupteurs indépendants Recherche web, Explorateur et Mémoire ;
  Mémoire conditionne désormais les outils de mémoire/rappel ainsi que l'injection de mémoire
  centrale, tandis que les cycles de mémoire d'arrière-plan sont passés dans Contexte comme leur propre
  interrupteur.
- Les exécutions de rôle sans interface et les sessions de banc d'essai démarrent avec explorateur, recherche web et
  mémoire désactivés (surface classique) et les réactivent par exécution via des indicateurs ou des
  variables MIXDOG_FEATURE_*.
- La politique d'outils partagée supprime le tour obligatoire de vérification après modification,
  retient la preuve suffisante la moins coûteuse par recherche, et définit explore comme une recherche
  de source simple sur les arbres et fichiers sources avec une cible concrète par
  requête.

## v0.9.100 - 2026-08-07

- Le style de la commande de contexte ne dépend plus de l'ouverture préalable des Réglages et n'entre
  plus en collision avec la classe de contexte globale de Monaco, et le rattachement de la transcription
  n'annule plus un petit mouvement de molette du lecteur.
- Les empaqueteurs du bureau restaurent désormais les téléchargements npm avec une clé de cache limitée aux dépendances,
  de sorte que les estampilles de version de publication ne démarrent pas à froid chaque installation de plateforme.
- Les brouillons masqués sont traités comme un travail reprenable plutôt que comme des publications livrées,
  empêchant les publications échouées de consommer un numéro de correctif supplémentaire.

## v0.9.99 - 2026-08-07

- La typographie de la transcription du bureau sépare désormais le contenu, l'état opérationnel et
  les métadonnées en une hiérarchie plus stable, tandis que Fast utilise une icône compacte à états.
- La récupération de l'explorateur éclate désormais chaque facette de localisation concrète une seule fois, préserve
  mot pour mot les chemins renvoyés, et arrête la récupération bornée au lieu de renvoyer une
  ancre faible ou reconstruite.
- Les lectures synchrones du catalogue de modèles ne lancent plus de requête réseau globale implicite.
  Le préchauffage de session reste le seul propriétaire des E/S du catalogue distant, de sorte que
  les transports injectés par le fournisseur restent hermétiques sur une installation à froid.
- La voie de publication isolée prépare désormais explicitement un runtime natif de code-graph vérifié
  au lieu de dépendre d'un binaire ambiant laissé par un job précédent.
- Les ressources de publication macOS Intel utilisent des téléversements HTTP/1.1 bornés, fichier par fichier, avec
  vérifications d'achèvement distantes et nouvelles tentatives, empêchant qu'un transfert CLI bloqué
  retienne indéfiniment toute la publication.
- La reprise d'une publication non publiée de même version intègre désormais ses notes accumulées
  dans cette version avant de publier, au lieu de laisser un travail livré marqué
  comme Unreleased.

## v0.9.98 - 2026-08-07

- L'appairage du navigateur distant établit désormais un canal chiffré de bout en bout authentifié
  avant que tout état de session, donnée de terminal ou charge utile RPC puisse traverser le
  relais ; les voies média non chiffrées restent fermées.
- Les pièces jointes du bureau préservent l'identité et les métadonnées des fichiers à travers la frontière de
  session, avec une extraction bornée d'images/PDF et une normalisation des médias partagée
  pour les entrées des fournisseurs.
- L'accueil du bureau et les textes de réglages associés sont localisés dans toutes les langues
  livrées, tandis que la composition IME, le suivi de la transcription virtuelle et les contrôles du
  mode fast se comportent de façon cohérente dans les volets de longue durée.
- La récupération de session, la livraison des messages en attente, la mise en cache du catalogue des fournisseurs, la
  génération de titres, les instantanés de worktree et les métriques de runtime bornées sont resserrés
  autour du service de session unifié.
- La validation de publication est scindée en voies parallèles, la compilation du bureau chevauche
  les portes, les runtimes préparés sont mis en cache, et les paquets de plateforme sont téléversés vers un seul
  brouillon masqué avant la publication atomique. Les dépendances réservées au moteur de rendu ne sont plus
  dupliquées dans l'archive du bureau, ce qui réduit l'installateur Windows d'environ un tiers.

## v0.9.97 - 2026-08-07

- Le protocole de session 1 porte désormais un index de compatibilité explicite, permettant aux
  clients plus récents de rejeter des démons plus anciens tandis que les clients plus anciens peuvent s'attacher via la
  surface de compatibilité prise en charge sans piles moteur/backend parallèles.
- Les flux du bureau, du terminal, des canaux, d'OAuth et de la mémoire partagent désormais le démon de session
  unifié à l'échelle de la machine ; les transports moteur/backend obsolètes, les replis
  et les cales de compatibilité ont été retirés de la ligne de développement.
- La propriété des sessions et les portes de charge des outils coordonnent désormais le travail parallèle de shell,
  patch, read, code-graph, mémoire et canaux avec une admission équitable,
  moins d'E/S dupliquées et une couverture d'annulation/récupération renforcée.
- Le focus multi-volets du bureau, le glissement des onglets, l'état de revue, les notifications, le nommage des
  fournisseurs, les diagnostics de mise à jour et l'empaquetage des mises à jour de développement ont été
  resserrés, avec des tests de régression du moteur de rendu et du transport de session élargis.
- Les commandes de reproduction de Terminal-Bench et la validation des coûts pointent désormais vers
  l'exécution archivée exacte et échouent clairement lorsqu'un ensemble d'essais demandé est absent.

## v0.9.96 - 2026-08-07

- La discipline de publication exige désormais que chaque paquet d'application soit pré-incrémenté lorsque
  le protocole réseau du moteur change, garde les versions de l'espace de travail synchronisées, et
  publie cette identité en attente sans second incrément accidentel.
- Les surfaces de développement et installées continuent à partager le magasin existant de données et
  d'authentification ; la discipline de protocole/version empêche le décalage de démon de même version
  sans cacher les identifiants derrière un nouveau profil.
- La validation de publication conditionne désormais l'empaquetage des plateformes et supprime une exécution
  dupliquée du code-graph, évitant cinq coûteux jobs de paquets quand une porte ciblée échoue.
- Les conflits de protocole du bureau expliquent désormais le chemin de récupération par mise à jour/fermeture et
  réouverture au lieu de faire apparaître une exception brute du transport de session.
- Le démon unifié de protocole 1 supprime l'hôte de session de bureau en double,
  rétablit le comportement de reconnexion/resynchronisation du démon, et préserve le travail d'outils terminé
  à travers les frontières de délai d'expiration et d'annulation.

## v0.9.95 - 2026-08-06

- Un processus global à la machine possède chaque session en direct, et la TUI du terminal ainsi que
  chaque fenêtre de bureau s'attachent comme des vues via un transport HTTP+SSE 127.0.0.1, de sorte qu'il
  n'y a aucun rôle propriétaire/observateur à négocier entre les surfaces.
- Les invites soumises ne peuvent plus être perdues entre surfaces. La soumission d'une vue du démon
  conserve sa réponse synchrone mais est retentée jusqu'à ce que le moteur la prenne
  (et redélivrée après un redémarrage du démon), une soumission en partage direct est
  accusée par le propriétaire et se rabat sur la file durable lorsqu'elle est
  refusée ou sans accusé, et la file écarte un identifiant de soumission redélivré
  au lieu de publier deux fois le message.
- Édition inter-clients : reprendre une session qu'une autre vue détient déjà adopte
  ce moteur en direct au lieu d'en charger une seconde copie, les trames du moteur se diffusent à
  chaque vue, et un moteur ne se termine qu'avec sa DERNIÈRE vue — de sorte qu'un terminal et
  une fenêtre de bureau peuvent piloter une même session tour par tour.

## v0.9.94 - 2026-08-05

- La bande d'onglets du bureau rétrécit les onglets ensemble vers les planchers actif/inactif
  avec chaque onglet visible au lieu de défiler, et les coques tactiles se replient en une
  liste de bascule titre + compteur.
- Le Markdown en streaming répare la queue en direct (`**`, `` ` ``, `~~` non fermés) et
  limite le verrou de géométrie du code délimité à son propre fragment, de sorte que les titres, listes
  et le gras sont mis en forme pendant que le modèle tape encore.
- La revue de tour est déplacée dans la chronologie défilante (les diffs de tour voyagent avec
  le fil), mettant fin au décalage de la pile du compositeur à l'entrée d'une session ; les notices
  de ton avertissement utilisent désormais la paire d'états ambre au lieu de la paire neutre.
- La bande de légende native est transparente afin que la barre de titre DOM et les voiles des boîtes de dialogue
  l'assombrissent directement ; la paire ◀ ▶ de cycle de volets est retirée (Alt+Gauche/Droite conserve
  le cycle de focus) et les boîtes de dialogue de projet détiennent la revendication d'assombrissement de la barre de titre.
- La capture de l'interface du bureau pilote Nouvelle tâche et Réglages via Ctrl+N / Ctrl+,,
  épingle la langue de capture, et vérifie la disposition étroite de 360 px des réglages.
- Affinements de la fenêtre de transcription de la TUI et du harnais de gigue, ainsi que sondes
  de course de sélection de session du bureau.

## v0.9.93 - 2026-08-04

- Audit des dépendances ramené à zéro dans le cœur et le bureau : `npm audit fix` pour
  fast-uri, ip-address, hono/@hono/node-server, undici racine et
  brace-expansion ; le remplacement d'undici imbriqué de discord.js passe à 6.28.0 ;
  le remplacement `dompurify` du bureau `^3.4.12` élimine le lot de XSS de Monaco.
- Audit des fonctionnalités du README : section de l'atelier de bureau, détail du sous-système de mémoire,
  appairage QR du relais, cron en heures calmes et transcription Whisper locale,
  sessions de volets parallèles, assistant d'accueil.
- Discord : suppression de la dernière commande slash enregistrée (`/stop`) ; le démarrage
  efface toujours les ensembles de commandes globaux/de serveur périmés.
- Terminal-Bench 2.1 : résultats corrigés, graphiques de comparaison de remplacement et
  scripts de reproduction/vérification.
- CI : Deploy est désormais le point d'entrée unique de publication (chaîne d'approvisionnement des jetons
  intégrée, portes dérobées de push de tag supprimées) avec une porte de journal des modifications de publication.
- Versions de paquets unifiées à 0.9.92 (mobile/relais alignés) et historique du dépôt
  écrasé jusqu'à une racine propre.

## v0.9.92 - 2026-08-02

- Version de référence : paquet npm, installateurs de bureau et ressources natives de la chaîne
  d'approvisionnement (runtime, patch, graph, token, runtime vocal).
