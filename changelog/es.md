# Registro de cambios

Cambios destacados, de más reciente a más antiguo. La canalización de Deploy se niega a publicar mientras
la sección Unreleased esté vacía, y la marca con la versión publicada.

## Unreleased

- El registro de cambios de Ajustes > Acerca de muestra las notas de la versión instalada;
  en v1.0.11 aún terminaba en v1.0.10, tanto en la aplicación de escritorio como
  en la página web remota.

- El registro de cambios está disponible en todos los idiomas de la aplicación y, tras una
  actualización, la aplicación muestra una vez las novedades de esa versión.

- El Razonamiento automático está activado por defecto en los modelos compatibles: cada mensaje y
  cada paso de herramienta recibe el esfuerzo de razonamiento que necesita. Su modelo se descarga
  en segundo plano en el primer uso en lugar de al iniciar, y la tarjeta Integrado
  muestra el modelo y en qué se basa.

- Los enlaces a archivos en una conversación se abren a su lado, en el panel lateral, como pestañas. Un
  enlace nuevo reemplaza la pestaña de vista previa, así que los enlaces ya no acumulan pestañas; una pestaña
  se conserva cuando haces doble clic en ella, eliges Mantener abierto o editas el archivo. Como
  máximo se mantienen abiertas ocho pestañas de archivos. Ajustes > General > Vista previa de enlaces lo
  desactiva.

- Los archivos CSV y TSV se abren como una tabla editable: copia y pega celdas, añade o
  elimina filas y columnas, guarda con Ctrl+S y deshaz o rehaz con Ctrl+Z
  y Ctrl+Y.

- Los archivos PDF y de Office (Word, PowerPoint, Excel) tienen vista previa en el panel lateral.
  Las páginas de Office se reabren al instante, y un enlace empieza a convertir su documento
  en cuanto lo señalas con el cursor.

- Las conversaciones se pueden marcar con estrella: los favoritos permanecen al principio de la lista
  de sesiones, y la estrella aparece al pasar el cursor sobre una fila.

- La búsqueda encuentra texto en conversaciones anteriores. Una conversación eliminada
  no deja resultados de búsqueda, sea cual sea la forma en que se eliminó.

- Al desplazarte hacia arriba mientras se transmite una respuesta, se mantiene tu posición en lugar de saltar
  de nuevo al final.

- Las acciones de GitHub de una respuesta se agrupan en una sola tarjeta de GitHub, y el bucle del
  indicador de razonamiento ya no da un salto al reiniciarse.

- Las cuentas de proveedor muestran el correo con el que iniciaron sesión, y volver a conectar la misma
  cuenta conserva su nombre y su historial de uso en lugar de añadir una entrada nueva.
  El diálogo de uso ya no lista las cuentas que se desconectaron.

- Un prompt devuelto de la cola al borrador ya no reaparece tras un reinicio, y
  reabrir la aplicación rápidamente mantiene la conversación editable en lugar de abrirla
  en solo lectura.

- Correcciones de traducción: etiquetas erróneas como Git en italiano, Models en
  vietnamita y Effort en chino y japonés ahora se leen correctamente.

- En la interfaz web del teléfono, Intro inserta un salto de línea y el botón de envío
  envía.

- Memoria se inicia en perfiles de Windows cuyo nombre de carpeta de usuario no es ASCII
  simple.

- Actualizaciones de seguridad de las dependencias image-size y js-yaml
  (CVE-2025-71329, CVE-2026-84375).

## v1.0.11 - 2026-10-08

- El navegador integrado vuelve a mostrar páginas en pantallas de Windows con escala superior
  al 100 %, en lugar de fallar con "Browser display did not recover after the
  page changed" (#8). Las páginas también siguen los cambios de escala de la pantalla, incluidas
  las pestañas que no estaban a la vista en ese momento.

- Los archivos de Word, PowerPoint y Excel (.docx, .pptx, .xlsx, .xlsm) se pueden
  adjuntar a mensajes y automatizaciones, y su texto llega a todos los modelos.
  Los tipos de archivo que no se pueden adjuntar ahora lo indican e insertan en su lugar
  la ruta del archivo, y los archivos vacíos o que no son PDF reales se rechazan con
  un mensaje claro.

- Los PDF y las imágenes de fases anteriores de una conversación se siguen enviando al modelo
  después de reiniciar la aplicación. Los modelos sin compatibilidad nativa con PDF reciben el
  texto del PDF. Al leer un PDF de más de 100 páginas se devuelven sus primeras páginas como texto,
  y los PDF protegidos con contraseña o no válidos devuelven un error claro en lugar de
  romper las solicitudes posteriores.

- Las imágenes y los archivos devueltos por herramientas MCP llegan al modelo como imágenes y archivos
  en lugar de texto codificado sin procesar; los medios no admitidos o demasiado grandes se describen.

- Los resúmenes que se generan al compactar una conversación larga ahora incluyen los mensajes
  largos e indican las imágenes y los archivos adjuntos.

- Los modelos locales de solo texto conservan el texto de los documentos adjuntos, y las imágenes
  anteriores se convierten en una nota breve en lugar de detener la conversación.

- Los comentarios, con capturas de pantalla opcionales, se pueden enviar desde Ajustes > Acerca de,
  y allí también se puede leer el registro de cambios.

- Los mensajes recientes de la conversación se pueden encontrar por significado en la recuperación
  de memoria justo después de guardarse.

- Los resultados de búsqueda solo se reutilizan mientras siguen siendo recientes (#7), y una
  búsqueda de listas de archivos después de una búsqueda de contenido devuelve nombres de archivo en lugar del
  contenido anterior (#9).

## v1.0.10 - 2026-10-08

- Los proveedores de API personalizados se pueden registrar en Ajustes con adaptadores de
  conexión específicos de cada proveedor.

- Los códigos QR de conexión remota aparecen solo cuando el relé está listo, y las tarjetas
  de emparejamiento obsoletas se eliminan.

- Los alias de modelos de OpenRouter que se actualizan automáticamente se pueden seleccionar y guardar para Principal y
  los agentes. Los alias más recientes y los modelos estables ya no se ocultan por error
  por la antigüedad del catálogo, las vistas previas más nuevas ni los límites de familia del selector de modelos.

- La inicialización del parche nativo mantiene activo su proceso mientras la verificación está
  pendiente, lo que evita una salida anticipada cuando el precalentamiento y la verificación se solapan.

## v1.0.9 - 2026-10-07

- Las instrucciones comunes y del proyecto llegan a cada conversación nueva incluso cuando
  la extensión Memoria no está instalada o está desactivada; ese interruptor ahora
  solo afecta a las herramientas de memoria y recuperación. Guardar una instrucción ya no
  espera varios segundos al modelo de embeddings, las instrucciones se incorporan tal
  como están escritas, sin identificadores internos, y pueden sumar hasta 32 KB.

- Iniciar sesión en GitHub desde Ajustes, y cualquier otra función que inicie un
  proceso de terminal, vuelve a funcionar en la aplicación de escritorio instalada en lugar de
  fallar con "posix_spawnp failed". Una cuenta extra de GitHub obsoleta guardada por
  gh ya no hace que un inicio de sesión correcto informe "no account is signed in".

- Browser Use y Computer Use ya no piden aprobación antes de su primera
  llamada en una sesión, y `setup set_first_use_approval` ha desaparecido.

- La tarjeta de aprobación de herramientas coincide con las tarjetas apiladas sobre la entrada: el
  icono de advertencia, el título y la herramienta comparten una línea, el motivo queda debajo con
  solo el comando, la ruta o la URL que se aprueba (sin fila de carpeta ni volcado de
  argumentos), y Denegar queda discretamente junto a Permitir.

- Los modelos nuevos obtienen sus capacidades de los catálogos de los proveedores en lugar de
  esperar a una versión: cambios de esfuerzo a mitad de conversación en la ruta de ChatGPT,
  ajustes de Fast mode y de caché en la ruta de la API de OpenAI, Fast mode en
  Claude y esfuerzo de razonamiento en xAI. GPT-6.1 Sol y Claude Sonnet 5.5 quedan
  cubiertos ahora, y el interruptor Fast ya no aparece en los modelos de Claude que
  no pueden usarlo.

- Claude Sonnet 5.5 vuelve a mostrar sus notas entre llamadas a herramientas, y los modelos
  Claude Fable y Mythos pueden usar la búsqueda web alojada.

- La versión de cliente que espera cada proveedor se recuerda entre ejecuciones, de modo que
  un reinicio o un inicio sin conexión ya no recurre a un valor integrado antiguo.

- Más errores de "conversación demasiado larga" de GLM, Kimi, Qwen, MiniMax, xAI y
  otros backends ahora activan la compactación en lugar de terminar el turno, y una
  sobrecarga de Claude a mitad de respuesta sigue las mismas reglas de reintento y alternativa que una
  al inicio de la respuesta.

- Los avisos y errores ya no se apilan sobre la entrada: las confirmaciones de comandos de barra
  y los fallos de micrófono, adjuntos y comandos aparecen como
  notificaciones, y el progreso de la descarga de voz se muestra solo en su tarjeta de Ajustes.
  Ahora todos los errores se leen igual, sin tarjeta con borde, y las descargas de
  modelos locales muestran una barra de progreso de ancho completo bajo su fila.

## v1.0.8 - 2026-10-05

- La aplicación para macOS está firmada con un certificado Developer ID y notarizada por
  Apple, de modo que una copia descargada se abre sin advertencia de Gatekeeper y la
  actualización automática de macOS puede instalar versiones nuevas. Los avisos de micrófono y AppleScript
  ahora explican para qué los usa Mixdog.

## v1.0.7 - 2026-10-04

- Browser Use en el teléfono transmite la página del escritorio en directo en lugar de
  actualizar instantáneas, y admite la misma entrada de ratón, táctil, rueda, teclado e
  IME que el panel de escritorio. Cuando un agente cede la página (por
  ejemplo, un CAPTCHA), el teléfono también la abre.

- La actividad de herramientas en la transcripción es más fácil de recorrer: cada fila empieza con un
  verbo breve, las lecturas y búsquedas muestran resultados por archivo, los listados muestran filas
  de archivos, los comandos van en su propio recuadro, la salida de `git diff` se muestra como diff,
  y una página visitada por el navegador obtiene una tarjeta que la reabre en el panel.

- Las notificaciones de turno terminado llegan antes, muestran texto sin formato en lugar de Markdown
  sin procesar, terminan en una frase completa y ya no se retrasan por
  tareas de shell en segundo plano de larga duración.

- Las sesiones usadas recientemente se abren más rápido tras un reinicio y al volver a visitarlas.

- La herramienta de configuración puede gestionar cuentas OAuth, opciones de desarrollador, anclajes del
  carril de actividad y el servidor MCP de un plugin, y se atienden las solicitudes de sesiones en
  paneles divididos. La ventana de borrado automático propia de un proveedor ahora prevalece sobre la global.

- La herramienta Git se activa dondequiera que `git` esté instalado, sin instalar una
  extensión. Las programaciones y los webhooks siempre se entregan a la sesión de la aplicación.

- La interfaz de la aplicación se mantiene al 100 % de escala, los ajustes guardados en otra ventana o
  terminal se aplican de inmediato, y los bordes, los iconos, el espaciado de las listas y las
  entradas de los diálogos son más coherentes.

## v1.0.6 - 2026-10-03

- Las notificaciones push del teléfono permanecen en silencio mientras la aplicación está en pantalla, siguen
  una suscripción que el navegador renueva por sí solo, y el interruptor se desactiva cuando
  las notificaciones están bloqueadas en los ajustes del sistema.

- La aplicación del teléfono ya no se queda en su pantalla de carga cuando vuelve tras
  una actualización del relé; termina de cargar en cuanto el escritorio se reconecta, y
  un primer inicio rápido ya no omite la instalación del service worker de la aplicación.

- En Android, el gesto de retroceso cierra el panel o menú abierto sin
  hacer parpadear la barra de navegación.

- Las pestañas del espacio de trabajo, el encabezado del panel lateral y el botón de limpieza de Studio son
  más compactos, y la pestaña seleccionada destaca con más claridad.

- Las etiquetas de uso son más cortas, la asignación hasta el reinicio se expresa por hora cuando
  queda menos de un día y nunca supera lo que queda, y las traducciones están
  pulidas en todos los idiomas.

## v1.0.5 - 2026-10-03

- La aplicación de escritorio puede mostrar una notificación del sistema, con sonido, cuando un turno
  termina con su respuesta final, y la notificación lleva de vuelta a esa
  sesión.

- Las herramientas de Office crean documentos docx, xlsx y pdf a partir de HTML mediante una
  sesión de navegador compartida.

- Uso muestra estimaciones del valor de la cuota y totales por sesión.

- Los hosts de Browser Use y Computer Use son más robustos: transformaciones de fotogramas, privacidad
  visual, capturas de pantalla en mosaico y recuperación tras fallos.

- La comprobación de sintaxis de PowerShell ya no confunde fragmentos de verbo y guion dentro de
  rutas con cmdlets.

- `adm-zip` se actualiza a 0.6.1 por CVE-2026-102282.

## v1.0.4 - 2026-10-01

- Los selectores de modelos se actualizan en cuanto cambia un proveedor. Los inicios de sesión OAuth
  basados en navegador (OpenAI, Grok, Cursor, Antigravity) y los cambios de cuenta ahora
  recargan el selector de inmediato en lugar de tras un reinicio, y un proveedor
  conectado, eliminado o cambiado en una ventana también actualiza todas las demás
  ventanas de escritorio y teléfonos emparejados.

- Cerrar la ventana ya no pregunta qué hacer. Ajustes ofrece una opción "Al cerrar la ventana"
  entre ocultar en la bandeja (el valor predeterminado) y salir por completo,
  el icono de la bandeja está disponible desde el inicio, y el aviso de confirmación de salida
  dentro de la aplicación ha desaparecido.

- Las filas de agentes de los workflows se leen igual en todas partes: una fila sin modelo
  fijado, incluida Web Search, muestra "Predeterminado", y los nombres de los agentes y las etiquetas
  de modelo no se traducen. Las pestañas del espacio de trabajo no seleccionadas descansan sobre una placa tenue
  en lugar de divisores finos.

- La herramienta Goal y la habilidad goal-management describen los objetivos como una lista de tareas
  para trabajo aprobado que se prolonga a lo largo de varios turnos, y excluyen las programaciones recurrentes y
  los objetivos que esperan semanas por eventos externos.

## v1.0.3 - 2026-10-01

- La generación de medios registra una fila de uso por cada trabajo de imagen o vídeo con los
  tokens, imágenes, segundos y coste que informó el proveedor, de modo que los medios de Gemini,
  Antigravity, Codex y xAI aparecen en los totales de uso y coste junto con los
  modelos de texto. Las tarifas de medios proceden del catálogo de precios publicado.

- Detener y Reanudar de Computer Use se recuperan limpiamente tras una limpieza fallida: los
  workers inactivos se retiran en lugar de agotar el tiempo de espera, y un Detener o Reanudar del usuario
  borra el estado obsoleto "input not confirmed released".

- Las sesiones que esperan tareas de shell en segundo plano se muestran como en espera en lugar de inactivas,
  y el indicador de tareas de shell ya no muestra las tareas de un propietario anterior ni pierde
  actualizaciones que llegan durante una consulta. Las listas de sesiones y agentes omiten redibujados
  redundantes cuando nada ha cambiado. El gráfico de uso, las páginas del carril, las pestañas del espacio de trabajo,
  las listas de extensiones y los diálogos tienen un estilo renovado.

- Los escaneos concurrentes idénticos de grep y read comparten un único escaneo nativo, los resultados
  en caché se invalidan por ruta tras las ediciones, y un parche cancelado se detiene
  antes de escribir más archivos. La búsqueda de code graph reconoce rutas de Windows
  sin importar mayúsculas, separadores, prefijos verbatim (`\\?\`) y UNC. Un
  hook previo a la herramienta que falla ahora bloquea la herramienta en lugar de dejarla ejecutarse.

- La habilidad del navegador mantiene las páginas en segundo plano salvo que la propia página
  sea el entregable o el usuario deba actuar sobre ella. El desarrollo de escritorio
  (`npm run dev`) y los scripts E2E directos de Windows se ejecutan en un perfil aislado nuevo
  en el puerto CDP `9342`.

## v1.0.2 - 2026-10-01

- Los botones de copiar de la transcripción pueden escribir en el portapapeles desde la
  ventana de escritorio de confianza. El texto de las respuestas, los bloques de código, la salida de herramientas y los diffs por archivo
  tienen cobertura de regresión para el texto copiado exacto, los reintentos y el contenido cambiante;
  las lecturas del portapapeles y los permisos para otras ventanas siguen bloqueados.

- Los comandos de modelo y esfuerzo abren el selector de modelos de la conversación actual, y
  los agentes desactivados conservan el modelo seleccionado para ellos. El tutorial inicial
  explica la recomendación del modelo Maintainer, y los diagnósticos ahora cubren
  proveedores locales, funciones integradas, voz y plugins ausentes o no válidos.

- Los enlaces de archivos de Windows manejan separadores codificados y rutas con espacios o
  texto coreano. Una mención de archivo cuya búsqueda inicial falló puede pulsarse
  para reintentar. Seleccionar todo de Studio incluye todos los elementos de la pestaña, no solo
  las páginas ya cargadas.

- Computer Use mantiene alineadas las referencias de captura con las relecturas de accesibilidad,
  revincula de forma segura los controles reconstruidos solo cuando su identidad observada coincide,
  y espera mientras el escritorio de entrada está bloqueado en lugar de tratar el bloqueo como
  un fallo del observador.

- Las pestañas del espacio de trabajo y el tutorial inicial tienen un estilo más claro, la barra lateral
  de sesiones empieza abierta, y los grupos de herramientas ya no muestran la insignia de fallo
  agregado. El texto de las instrucciones del proyecto ya no se añade al bloque de entorno
  del prompt del sistema. Los paquetes publicados excluyen las pruebas de desarrollo anidadas.

## v1.0.1 - 2026-09-30

- La aplicación de escritorio en Windows 11 ahora se asienta en un marco de ventana Mica con una interfaz más serena
  y monocromática: los menús emergentes y los paneles se separan con sombra en lugar de bordes,
  las selecciones ya no se vuelven azules y el acento se reserva para el estado en vivo. El texto
  sigue una única escala tipográfica (de pies de 12px a títulos de página de 20px y cifras
  destacadas), la pestaña seleccionada es una tarjeta elevada, los botones destructivos permanecen
  neutros hasta pasar el cursor, y los gráficos de uso y de contexto comparten una paleta.

- Al cerrar la ventana se pregunta una vez si mantener Mixdog en ejecución en la bandeja o
  salir por completo, y se recuerda la respuesta. Al salir mientras un agente sigue
  trabajando, se pregunta siempre.

- El uso de la suscripción muestra la parte de cada modelo como un área apilada bajo la
  línea del total, y su tarjeta emergente solo sigue al puntero dentro del gráfico.

- La conversación permanece anclada a su último mensaje cuando una tarjeta cambia de
  altura durante un desplazamiento. Los archivos SVG que escribe un agente aparecen como resultados de imagen
  y se abren en el visor del sistema, y los agentes entregan el trabajo visual, como
  SVG o páginas HTML, como archivos guardados en lugar de pegar su código fuente.

## v1.0.0 - 2026-09-30

- La memoria ya no puede quedar inutilizada por una reconstrucción del runtime. Un runtime de memoria
  reconstruido se publica con una nueva etiqueta de versión en lugar de reemplazar los archivos
  que las aplicaciones instaladas verifican, un runtime nuevo se instala junto al que está en uso
  en lugar de borrarlo mientras PostgreSQL aún se ejecuta desde él, y dos
  procesos que instalan a la vez ya no se borran mutuamente la descarga. Los despliegues
  de desarrollo local se niegan a ejecutarse desde una rama por detrás de su upstream.

- Las tarjetas de herramientas ya no marcan como fallidas las llamadas terminadas. Un comando cuya salida
  contiene una línea `status:`, un `git diff --quiet` o `git grep` que informa de una
  diferencia o de ninguna coincidencia, una consulta de code_graph que no encuentra el símbolo, y la paginación de
  resultados guardados de tidy ahora se muestran como completados; un comando git que termina con código distinto de cero
  se muestra como una salida, igual que el shell; y un comando de navegador o equipo detenido
  porque el usuario tomó el control se muestra como cancelado.

- Fallan menos llamadas a herramientas por un desliz de argumentos en el primer intento: la herramienta git añade un
  `git` inicial que falte, read declara en su esquema su límite de 10 destinos,
  y un Objetivo lleno de tareas completadas indica cómo hacer sitio para otras nuevas. Los registros
  de fallos ahora anotan los destinos de read y el tamaño total de los lotes de rutas.

- Las solicitudes se tarifican según el nivel con el que se enviaron realmente: las solicitudes Fast y
  Priority usan sus tarifas publicadas, una solicitud Fast reintentada como
  estándar se factura como estándar, y las variantes Fast de Cursor se facturan como su
  modelo de catálogo. Al activar o desactivar Fast, la línea de estado se actualiza de inmediato.

- Las reglas de validación de datos de Excel se comprueban antes de crear un libro, de modo que un
  tipo de regla desconocido o un límite ausente falla de entrada en ambos backends. El
  destello de actividad en vivo es una banda más corta y pálida, y los nombres de resumen de las herramientas usan el
  grosor medio.

## v0.9.175 - 2026-09-29

- Los agentes de Claude ahora mantienen su caché de conversación durante 5 minutos en lugar de
  una hora. Cuando la siguiente solicitud de un agente llega después de que esa caché haya caducado —
  tras una compilación o prueba larga, o cuando se retoma un agente terminado — este
  compacta primero su conversación, de modo que la solicitud reescribe la conversación compactada
  en lugar de todo lo que el agente había acumulado. En una reproducción del uso
  reciente de agentes de Claude, esto redujo el coste en tokens de los agentes en cerca de una cuarta parte. Las
  sesiones de Lead no cambian.

- Muchas sesiones en paralelo ya no se ralentizan entre sí. Los mensajes
  pendientes se guardan por sesión, los resúmenes de sesión y el uso del gateway se
  añaden en lugar de reescribirse, las transcripciones almacenadas se analizan fuera del bucle
  principal, y un ciclo de memoria que falla espera cada vez más en lugar de reintentar en un bucle
  cerrado. Cuando el daemon termina, registra el motivo. El host de sesiones
  multiproceso independiente ha desaparecido; las sesiones se ejecutan en el propio daemon.

- El uso de suscripción registrado antes de un cambio de cuenta ahora se cuenta para la
  cuenta que estaba en uso cuando empezó el registro. Grok, Claude y Cursor
  informan de sus versiones de cliente actuales en lugar de fijas.

- La aplicación de escritorio ya no muestra una sesión en blanco cuando el daemon entrega
  su contenido justo después de responder a la solicitud de apertura. El script de arranque de la aplicación empaquetada
  está permitido por la política de seguridad de contenido, y se han corregido las comprobaciones de raíz de proyecto,
  los errores de despacho del relé y la restauración de sesiones del navegador.

- Libros y documentos editados sin Office: borrar una celda vacía ya no
  elimina la celda siguiente, al eliminar un comentario se encuentran los comentarios con
  formato de autor, se resuelven las partes enlazadas por rutas absolutas, y el texto que
  parece un patrón de reemplazo se inserta literalmente.

- Los runtimes descargados (PostgreSQL, pgvector, fuentes, FFmpeg) se comprueban
  con sumas de verificación fijadas antes de usarse. Las herramientas nativas corrigen un análisis de id de ventana
  que podía partir un carácter multibyte, un cálculo de tiempo que podía
  desbordarse y un reemplazo de instantánea que podía dejar un archivo parcial.

## v0.9.174 - 2026-09-29

- El diálogo de uso ahora responde a una segunda pregunta: cómo se agotó la cuota de una suscripción.
  Junto al uso de tokens, una pestaña Uso de suscripción sigue las ventanas de límite propias de cada
  proveedor —Codex, Claude, Grok, Cursor, Antigravity y
  OpenCode Go— a medida que suben y se reinician, con los modelos que movieron el medidor
  y el historial de ventanas anteriores. Mixdog registra cada lectura de cuota que
  mide; una subida sin ninguna solicitud de Mixdog detrás se muestra como uso ajeno
  a Mixdog, por ejemplo la aplicación web del proveedor. Un medidor de proveedor en el
  panel de uso abre directamente su propia suscripción.

- `/doctor` también funciona en la aplicación de escritorio, como diálogo (también en Ajustes →
  Sistema → Doctor). Ejecuta las mismas comprobaciones de estado de solo lectura que la TUI, todas
  a la vez y con un plazo por comprobación para que una comprobación bloqueada no pueda ocultar
  las demás, y cada advertencia o fallo indica cómo solucionarlo.

- Las presentaciones nuevas de PowerPoint se diseñan en HTML. El modelo maqueta cada diapositiva en
  HTML y CSS, un Chrome o Edge local la renderiza, y `author` convierte lo que dibujó el
  navegador en objetos nativos y editables de PowerPoint: cuadros de texto que conservan
  los saltos de línea del navegador, formas, líneas, tablas, gráficos e imágenes.
  El texto coreano se divide donde el lector lo espera, una comprobación de geometría rechaza las diapositivas
  cuyas alineaciones declaradas el navegador no puede confirmar, y `render` muestra
  cada página HTML junto a su renderizado de PowerPoint. La ruta por script se mantiene para
  presentaciones que quieran los dispositivos medidos del kit, o cuando no existe un navegador local.

- Insertar o eliminar filas y columnas en un libro sin Excel ahora
  reescribe todo lo que nombra esas celdas, igual que Excel: fórmulas de
  todas las hojas, nombres definidos y áreas de impresión, formatos condicionales,
  validaciones, series de gráficos, orígenes de tablas dinámicas, filtros, vínculos, combinaciones, tablas y
  dibujos. Antes las celdas se movían mientras sus referencias seguían igual, así que el total de un
  informe seguía sumando el rango antiguo y mostraba 72,200 donde Excel mostraba
  74,700. Una edición cuyas referencias no se pueden reescribir se rechaza, con la
  lista, antes de que cambie nada.

- Los PDF y las bandas de hoja de cálculo compuestas mantienen en una sola línea las fechas, horas, fracciones y
  cantidades coreanas. "10월 14일", "14시 30분", "3분의 1", "12만 6천 원" y
  "24억 원" ya no se parten por la mitad, lo que había dividido una fecha de decisión o
  un ahorro en dos líneas.

- Los archivos de Office salen igual tanto si los produjo Microsoft Office como el
  escritor portátil integrado. Una larga comparación lado a lado de ambos
  alineó el espaciado, el modo de compatibilidad y las tablas de Word; el autoajuste, las sangrías,
  los bordes, la configuración de impresión y los gráficos predefinidos de Excel; el ajuste de texto coreano,
  las fuentes de Asia oriental, los pies, los recortes de portada, las sombras y la transparencia de PowerPoint; y
  la alineación y los anchos de tabla de PDF. Las comprobaciones de revisión informan de los mismos problemas en ambos
  backends, los gráficos de Excel pueden leer el rango de otra hoja, y `set_chart_data`
  conserva los vínculos y los nombres de serie de un gráfico.

- Computer Use funciona en macOS y Linux. Las compilaciones de escritorio para esos sistemas
  incluyen un backend nativo que habla el protocolo del host de Windows y aplica
  las mismas listas de acciones y límites. Una secuencia ahora también puede actuar sobre varios
  elementos de una observación: cada paso posterior vuelve a demostrar su elemento frente
  al árbol de accesibilidad en vivo, y la cadena se detiene ante un cambio de ventana, un
  fallo, o un elemento desactivado o fuera de pantalla.

- La aplicación del teléfono se abre y reconecta más rápido y mueve muchos menos datos. La
  transcripción se muestra justo después de la primera sincronización, las reconexiones cortas se reanudan
  como deltas en lugar de una resincronización completa, el teléfono refleja solo la pestaña que muestra,
  la revisión de turno contraída lee nombres de archivo y recuentos sin texto de parche,
  y las búsquedas lentas en proyectos ya no retrasan otras llamadas. Una aplicación de teléfono mantenida
  abierta comprueba si hay un despliegue nuevo al volver al primer plano, y
  adopta uno fuera de pantalla incluso a mitad de turno.

- El daemon usa menos memoria y se bloquea menos: las sesiones guardan solo lo que
  cambió, el registro de uso trabaja fuera del hilo principal, los bloqueos de archivos y las llamadas a
  git ya no lo bloquean, y las transcripciones largas se paginan en pasos de 1 MB. El escritorio
  y el teléfono renderizan Markdown en streaming y el desplazamiento táctil con menos maquetaciones,
  y la transcripción de la aplicación web ya no tiembla mientras se miden las filas.

- La entrada de voz indica que se está preparando hasta que la captura realmente empieza,
  precalienta la transcripción mientras se habla, y transcribe más rápido sin bloquear
  la aplicación.

- Los resultados de herramientas cuestan menos tokens al modelo. `read` devuelve sus filas sin
  números de línea —la TUI y el escritorio siguen dibujando la columna— con cerca de un 16 %
  menos de tokens en sesiones grabadas; los avisos de shell y de tareas son más cortos; y
  las ediciones informan de rutas relativas al directorio de trabajo.

- La compactación arrastra menos material obsoleto en ventanas de contexto grandes. La
  conversación literal y el historial reciente de herramientas conservados en una Compactación están
  limitados a 20,000 tokens en lugar de crecer con la ventana. Una instantánea de navegador o
  una observación de escritorio que otra posterior de la misma página o ventana
  reemplazó conserva solo su resultado y un puntero al original archivado,
  y las respuestas más antiguas descartan su reproducción opaca del proveedor mientras conservan sus llamadas a
  herramientas y resultados.

- Un proveedor que no está disponible brevemente ya no termina el turno en cuanto
  se agotan sus propios reintentos. Mientras nada haya llegado a la pantalla, el turno
  espera durante unos cuantos ciclos de recuperación más, de 15 segundos hasta un minuto,
  y respeta el Retry-After del propio servidor. Cuando un stream se corta mientras los argumentos de una llamada a
  herramienta aún están llegando, esa llamada no se ejecuta, y se indica al modelo
  que divida el contenido en llamadas más pequeñas en lugar de reenviarlo
  completo.

- OAuth de Cursor y de Antigravity (Gemini) son interruptores independientes en Ajustes →
  Desarrollador, y cada uno se activa solo después de confirmar el riesgo de restricciones de cuenta
  que conlleva usar ese proveedor mediante OAuth. La variable de entorno
  `MIXDOG_DEV_PROVIDERS` ya no los activa.

- La conversación ya no salta cuando las barras sobre el compositor se abren o
  cierran: se deslizan sobre el movimiento en lugar de desplazar la transcripción
  toda su altura de golpe, y al abrir una sesión ya no parpadea un recuento de revisión de turno
  que desaparece un momento después.

- Al renombrar un archivo o carpeta en el explorador, sus pestañas de editor abiertas pasan a la
  nueva ruta. Un archivo con ediciones sin guardar se rechaza hasta que se guarde, ya que su
  búfer pertenece a la ruta antigua.

- Studio limpia en bloque: los elementos seleccionados, todo lo anterior a una fecha,
  entradas cuyos archivos ya no existen, o todo de un mismo tipo. Ajustes → Acerca de muestra una
  dirección de soporte con botones Copiar y Email, y el diálogo Clear browsing data
  del navegador integrado se ha eliminado.

- Un turno de objetivo automático que no llama a ninguna herramienta ahora espera en lugar de volver
  a solicitar.

## v0.9.173 - 2026-09-22

- Un mensaje en cola restaurado conserva el texto que confirmó el daemon. Al restaurar uno
  se publica dos veces en el mismo instante —primero la suposición local, la
  respuesta del daemon un momento después— y ambas se marcaban con el reloj. Cuando
  coincidían en el mismo milisegundo, el prompt trataba la segunda como la primera y
  conservaba la suposición, de modo que un mensaje editado podía volver sutilmente incorrecto. El prompt
  ahora sigue el propio texto, no solo la marca de tiempo.

- Saltar dos veces en un mismo instante ya no pierde el segundo salto. Dos solicitudes de "ir a esta
  línea" dentro del mismo milisegundo llevaban la misma marca, y el
  editor leía solo la marca, así que la segunda se descartaba y el cursor se quedaba
  en la primera línea.

- Una búsqueda que se bloquea ya no arrastra consigo a todo el motor de búsqueda. El
  motor ya sabía responder a una solicitud errónea con un error y seguir
  funcionando, pero la compilación distribuida estaba hecha de modo que cualquier fallo mataba el
  proceso —perdiendo todas las demás búsquedas en curso y el índice de archivos
  en caliente. Ahora sobrevive, responde a esa solicitud con un error y conserva
  sus cachés. Si un fallo ocurre mientras se recopilan archivos, las
  rutas ya recopiladas se publican igualmente en lugar de desaparecer en silencio de
  la respuesta.

- Aplicar y Eliminar en una fila de proveedor local quedan en la misma línea. Se diferenciaban
  en dos píxeles porque la fila mezclaba un campo de entrada más alto con un botón más bajo.

- La limpieza de código te avisa cuando una herramienta no es la que crees. Si un
  formateador o linter con el mismo nombre es accesible en tu equipo pero no
  es el que ejecuta Mixdog, el informe ahora nombra ambos, con sus versiones:
  ejecutar ese otro binario no dice nada sobre el resultado que se te mostró. Una ejecución de limpieza
  también separa los hallazgos en archivos que ya has tocado de los hallazgos en
  archivos sin tocar del repositorio, de modo que aplicar correcciones a un directorio entero
  ya no reescribe archivos que nunca quisiste cambiar.

- Actualizar tu aplicación instalada ya no se detiene porque tu antivirus eliminó un
  archivo que la actualización descarta de todos modos. La preparación desempaquetaba toda la aplicación instalada y
  borraba la parte que iba a reemplazar; un solo recurso del renderer en cuarentena
  bastaba para abortar el despliegue.

## v0.9.172 - 2026-09-21

- Una página ya no se abre anunciando descargas que nunca hizo. Los archivos guardados
  pertenecen a la sesión, pero cada página rastreaba lo que había informado empezando
  desde cero, así que cada página abierta después recibía al llamante con todo el
  atraso —una página de búsqueda informando de un archivo que otra pestaña había guardado minutos
  antes. Una página nueva empieza ya al tanto de lo ocurrido antes de que existiera;
  un archivo guardado mientras está abierta sigue llegándole.

- Los fallos propios del navegador ya no se leen como fallos de la página. Una llamada CDP agotada,
  un marco hijo que no se pudo adjuntar, una interceptación que no se pudo
  responder: todos se registraban como errores de consola de la página, así que una respuesta sobre un
  sitio sano podía empezar con `CDP Runtime.evaluate timed out` como si el sitio
  lo hubiera registrado. Siguen siendo legibles mediante `console`, marcados con `[browser]`, y
  ya no cuentan entre los errores de los que una página es responsable.

- Un plazo agotado tras un diálogo abierto lo indica. Un alert, confirm o prompt
  congela el hilo principal de la página, así que la siguiente llamada moría por tiempo de espera sin
  más que el plazo —y el reintento evidente agotaba el tiempo igual. El
  error ahora nombra el diálogo y su texto, e indica que hay que responderlo con
  `handle_dialog` antes de volver a actuar sobre la página.

- Un cambio de ruta del lado del cliente se responde con la pantalla que produjo, no con la
  que el llamante dejó. Las aplicaciones de una sola página mueven la dirección con `history.pushState`
  y renderizan la vista nueva un momento después; no se carga ningún documento, así que la espera vio una
  página quieta y volvió de inmediato —y un `expect.url` se cumplía con la nueva
  dirección antes de que se dibujara nada. Pulsar "Learn" en react.dev respondía con
  la página de inicio bajo la dirección `/learn`. Cuando una acción cambia la dirección
  sin una carga, la respuesta ahora espera a que la página se quede quieta y una condición de
  URL no puede acortarlo. Medido en el arnés con dispositivos reales:
  las latencias de navigate, click y snapshot no cambian, porque solo los cambios de ruta dentro del mismo
  documento tienen la espera adicional.

- El detalle de un WebSocket muestra la solicitud de actualización que realmente envió. Solo se
  registraban la dirección y la respuesta del handshake, así que `network` respondía con
  una sección de cabeceras de solicitud vacía —y una actualización rechazada suele explicarse
  por `Origin`, `Sec-WebSocket-Protocol` o una cookie. Las credenciales siguen ocultas.

- Un clic que abre una pestaña ya no se informa como un clic que no hizo nada.
  Un enlace `target="_blank"` deja intacto el documento actual, así que la respuesta
  decía "No observable change" e indicaba al llamante que buscara un elemento que lo cubriera,
  mientras la página que acababa de abrir estaba en `list_tabs` sin mencionarse.
  La respuesta ahora nombra la página que se abrió y cómo actuar sobre ella.

- `drag` admite destinos sin instantánea como cualquier otra acción de puntero. Sus dos
  extremos solo aceptaban refs o coordenadas sin procesar, y los elementos que una página hace
  arrastrables —tarjetas, filas de lista, zonas de soltado— a menudo no tienen nombre accesible y
  por tanto ningún ref, así que moverlos significaba fundamentar primero una instantánea visual incluso
  cuando se conocía el selector CSS. `target` y `dropTarget` ahora nombran los dos
  extremos, resueltos juntos en una observación; las refs y coordenadas funcionan
  como antes, y ambos extremos siguen debiendo direccionarse de la misma manera.

- Un archivo guardado ya no se anuncia como una solicitud fallida. Una dirección que
  se convierte en descarga cancela su propia navegación, y Chromium informa de esa
  cancelación como `net::ERR_ABORTED`, así que una respuesta que listaba la descarga
  también la listaba como un fallo de red reciente. Las solicitudes canceladas —descargas, fetches
  que la página abandonó, navegaciones reemplazadas por otra— siguen siendo legibles mediante
  `network` pero ya no se señalan por iniciativa propia como fallos de la página; una solicitud que
  falló de verdad sí se sigue señalando.

- Una respuesta `brief` ya no convierte un campo rellenado en un cambio de toda la página.
  Compara con la observación previa del llamante, y cuando esa observación
  estaba limitada o filtrada nunca había informado del resto de la página, así que cada
  elemento fuera de ella se listaba como "changed or new". Rellenar tres cuadros de un
  formulario respondía con quince elementos, y escribir una palabra de búsqueda respondía con
  ciento cuarenta y seis. La respuesta ahora separa lo que la acción cambió de forma demostrable
  de lo que la observación anterior simplemente nunca cubrió, e indica
  cuánto de la página contenía esa observación. En ambos casos no se omite nada.

- Las cabeceras de solicitud en `network` son las que realmente se enviaron. Chromium
  informa primero de un conjunto provisional y añade después idioma, codificación, client hints y
  cookies, así que el detalle de una solicitud podía mostrar dos cabeceras y dar a entender
  que la página nunca pidió contenido en coreano. Ahora se fusiona el conjunto posterior;
  las credenciales se siguen nombrando y nunca se muestran. Los nombres de cabecera no distinguen mayúsculas
  y los dos informes los escriben distinto, así que la fusión conserva una entrada por
  cabecera —la grafía y el valor que fueron por la red— en lugar de listar
  `User-Agent` y `user-agent` como si la solicitud llevara ambos.

- Los sitios ven Browser Use como la compilación de Chrome que los renderiza. La cadena de agente
  aún llevaba la versión de la aplicación de escritorio y el runtime de Electron, mientras que los
  client hints que recibían las mismas páginas nombraban solo Chromium; GitHub respondió a
  esa contradicción con un muro de inicio de sesión en un repositorio público. La partición
  del navegador ahora presenta la cadena de Chrome simple —una huella menos y
  menos rodeos por "navegador no compatible"— y un agente de usuario emulado sigue prevaleciendo
  cuando una tarea pide uno.

- Las páginas que siguen adjuntando marcos se pueden observar de nuevo. Los portales y las portadas
  de noticias abren espacios publicitarios y widgets en ráfagas, y una instantánea que empezaba
  a mitad de una ráfaga solía rendirse con "frame topology changed during observation"
  —de forma reproducible, en el primer y el segundo intento. Las observaciones no tienen efectos secundarios,
  así que el recolector ahora espera brevemente a que la ráfaga se asiente y vuelve a leer,
  hasta un pequeño límite, en lugar de entregar al llamante un error por una página que
  simplemente estaba ocupada. Cuando una lectura sigue fallando, la respuesta ahora indica que la página
  está cargada y solo falló su lectura, de modo que el siguiente paso es observar
  de nuevo en lugar de abandonar una página que está bien.

- Una página informa solo de sus propios fallos. Las solicitudes y los errores de consola del
  documento anterior permanecían en los registros, así que una instantánea de una página sana podía
  listar solicitudes abortadas del sitio visitado antes, y `console` en una
  página limpia podía responder con los errores de la página anterior; ambos enviaban al
  lector tras un fallo que no existía. Cargar un documento nuevo los borra;
  navegar dentro del mismo documento los conserva, porque nada se recargó.

- Las carreras de pantalla de Browser Use ya no son fallos. Una captura que pierde frente a una
  navegación o un cambio de tamaño de ventana ahora responde con un marcador de remuestreo en lugar de
  un error, porque el panel siempre iba a pedir de nuevo lo que
  mostrara la página a continuación. La navegación normal solía llenar el registro de la aplicación con fallos
  de captura —diecisiete en una ejecución del arnés, ninguno ahora— y un teléfono emparejado
  informaba de la misma carrera como "could not connect to browser screen"; ahora
  vuelve a muestrear a la cadencia activa e informa solo de una pantalla que realmente
  deja de avanzar.

- Borrar los datos de navegación de Browser Use. El panel del navegador tiene un botón de borrador que
  elimina la caché, los datos que los sitios guardaron en este dispositivo y las cookies, cada uno
  como decisión propia: la caché viene preseleccionada porque perderla cuesta una
  recarga más lenta, mientras que las cookies cierran la sesión en todos los sitios y nunca son el valor predeterminado.
  Cada ámbito se borra por separado, de modo que un fallo se informa como fallo
  en lugar de desaparecer tras los ámbitos que funcionaron. Borrar las cookies también
  reescribe el archivo sellado que conserva los inicios de sesión entre reinicios, de modo que un
  inicio de sesión borrado no vuelve la próxima vez que se abra la aplicación —y si
  ese archivo no se puede reescribir, las cookies se informan como no borradas en lugar de
  como hechas. Hasta ahora la partición compartida crecía en disco sin forma de
  recuperar el espacio.

- Las métricas de `performance` de Browser Use informan de la memoria del proceso que pinta
  la página, no solo del heap de JavaScript: una página cuyas imágenes y capas retienen
  la memoria solía parecer pequeña. La lectura nombra el proceso, ya que un mismo
  renderer puede pintar varias páginas del mismo sitio.

- La política de dominios de Browser Use cubre las conexiones entre pares. Cuando un operador
  restringe los dominios a los que una página puede llegar, WebRTC ya no sortea el
  filtro mediante STUN y TURN: las conexiones entre pares se rechazan en la página y
  en cada marco hijo. Sin política de dominios no cambia nada, y esto
  sigue siendo contención para el código de la página, no un límite de red.

- Capturas de elementos de Browser Use. `snapshot mode=visual` acepta `ref` o
  `target` y devuelve ese elemento como imagen propia. El recuadro se mide en
  píxeles CSS del documento superior —los marcos del mismo proceso suman su desplazamiento en
  el lado de la página, un marco de origen cruzado suma el desplazamiento de su sesión sin la prueba
  de impacto que protege la entrada, porque una imagen no despacha nada y un marco
  bajo una transformación CSS merece una igualmente— y el recorte se escala por la
  relación entre imagen y viewport, de modo que funciona
  en una pantalla ampliada o de alta densidad. Un elemento más alto o ancho
  que la ventana se recorta de la captura del documento en lugar del viewport, de modo que una tabla
  o artículo largo llega entero en lugar de terminar en el pliegue; solo una página demasiado
  grande para capturarse recurre a la parte visible, e informa de ello. La imagen es
  solo de inspección: nunca se vincula como anclaje de coordenadas, porque la ref
  sigue siendo la forma de actuar sobre el elemento. `mode=semantic`, `fullPage` y
  `format=pdf` rechazan un destino en lugar de ignorarlo.

- Fidelidad de entrada de Browser Use. `drag` ahora completa el arrastre HTML5 propio de una página:
  la interceptación de arrastre de Chromium entrega la carga que la página inició y
  el gesto termina como `dragEnter`/`dragOver`/`drop`, que es lo que realmente escucha
  una tarjeta kanban, una lista ordenable o una zona de soltado de archivos;
  las páginas que solo siguen eventos de ratón mantienen la ruta anterior. `type` envía un
  evento de tecla real por carácter en lugar de insertar toda la cadena, de modo que
  el autocompletado y los cuadros combinados guiados por pulsaciones reaccionan, mientras que los caracteres
  fuera del teclado de EE. UU. (coreano, emoji) se siguen insertando como texto. `press`
  envía los códigos de tecla de EE. UU. para la puntuación (`.` era Delete, `-` era Insert),
  evita que un atajo escriba un carácter y ya no deduce Shift de una
  letra mayúscula, lo que había convertido `Control+A` en `Control+Shift+A`.
  `upload` suelta archivos sobre un elemento que nunca abre un selector de archivos, con una
  protección que neutraliza un soltado sin gestionar —de lo contrario el navegador lleva
  la página al archivo soltado— e informa claramente cuando nada lo aceptó.

- Fidelidad de observación de Browser Use. `scroll text=` busca en marcos y shadow
  roots como hacen `read` y `expect`, elige una coincidencia entre todos ellos y ya no
  se desplaza a un elemento contraído. `expect.text` normaliza los espacios
  dentro de una línea pero conserva los saltos de línea, de modo que el marcado con sangría coincide mientras que dos
  bloques separados nunca se funden en una sola frase. Los diagnósticos de consola conservan
  lo que registró una página: los argumentos de objeto llegan como una vista previa legible en lugar
  de un mensaje vacío, las entradas nombran el script y la línea que un lector
  abriría, y un `throw` simple no capturado lleva su ubicación. Las instantáneas marcan
  `aria-hidden`, un `select` nativo fallido lista las opciones que sí encontró,
  y `aria-labelledby` se resuelve dentro de un shadow root.

- Browser Use cuenta los diagnósticos que no pudo incluir. Un informe de página muestra los
  tres errores de consola y fallos de red más recientes, que se leían como toda la
  historia: doce fallos llegaban como tres. El informe ahora indica el total y
  remite a `console` o `network` siempre que la lista está limitada.

- Browser Use admite cuándo un extracto de página se detiene antes. El texto visible de una
  instantánea está limitado, y el informe decía solo "condensed", así que un artículo largo
  se leía como si el extracto fuera toda la página. Ambas rutas de instantánea —la
  captura de accesibilidad y la alternativa DOM— ahora marcan un extracto recortado, y
  el informe indica cuánto contiene y dice que la página tiene más.

- Los adjuntos informan del tamaño de la imagen que realmente produjeron. Ajustar una
  imagen a un presupuesto de parches de visión recorta los bordes de uno en uno, lo que puede pedir
  un recuadro que la imagen no llena; la versión resultante salía más pequeña
  que el tamaño informado a su lado, y las coordenadas mapeadas con ese tamaño
  salían desviadas. El redimensionado ahora informa de las dimensiones de la imagen producida.

- Browser Use indica dónde falló un script de la página. `evaluate` conservaba solo la primera
  línea del error del navegador, así que un script de varias líneas informaba
  `TypeError: ...` sin nada para localizarlo. El fallo ahora lleva consigo el marco de
  pila más interno, y el arnés de integración fija la posición
  que informa un throw en una línea posterior.

- Browser Use nombra un PDF en lugar de informar de una página vacía. Abrir un enlace
  a un PDF confirmaba la dirección, pero el guest no tiene visor para él, así que la
  instantánea mostraba una página sin título ni texto y ruido de consola sobre una hoja de estilos
  de visor bloqueada: nada que dijera qué había pasado. El informe de la página
  ahora indica que el documento es un PDF que este navegador no puede mostrar y que
  el archivo hay que leerlo desde su URL, y los fallos que los componentes
  incluidos de Chromium generan para sus recursos `chrome-extension://` ya no
  aparecen como errores de consola o de red de la página. El arnés de integración
  cubre la navegación, el informe silencioso y una instantánea posterior de la página.

- Browser Use deja de rebotar `close_tab` sobre la pestaña visible. `list_tabs`
  imprime la página visible con un id de página normal, así que apuntar `close_tab` a
  ella se respondía con `unknown background tab "p12"; call list_tabs` —el
  listado que había dado el id. El rechazo ahora indica que la página pertenece al
  panel del navegador y sugiere navegarla a otro sitio o usar `hide`, y los nombres
  no relacionados siguen informando de una pestaña en segundo plano desconocida.

- Browser Use indica lo que realmente hizo una confirmación de salida. Una página que protege
  trabajo sin guardar detenía una navegación con un diálogo `beforeunload`, y la
  respuesta pedía `handle_dialog`, pero Chromium responde a esa confirmación
  por sí mismo, así que la llamada siempre volvía con "no JavaScript dialog is currently
  open" mientras repetir la navegación repetía la misma instrucción. La
  respuesta ahora indica que la navegación se abandonó y la página se quedó,
  que no queda nada por responder, y que el trabajo que contiene la página
  hay que terminarlo o descartarlo primero; el arnés de integración cubre toda la
  secuencia, incluida la navegación que se completa una vez desaparece la protección.

- La emulación de configuración regional de Browser Use llega al servidor. `emulate locale` fijaba
  solo `navigator.language`, así que la página seguía pidiendo el idioma antiguo
  y los sitios negociaban contenido que contradecía la emulación; ahora lleva la
  configuración regional también como `Accept-Language`, y al borrarla se restablece la negociación
  propia del navegador.

## v0.9.171 - 2026-09-18

- Recuperación de versión: el artefacto del relé de producción preparado se identifica solo por
  la ejecución (`production-relay-<run_id>`) y se sube con `overwrite: true`. El
  nombre incluía el intento de ejecución, pero una reejecución parcial conserva el trabajo correcto
  `stage-production-web-relay` mientras reejecuta
  `deploy-production-web-relay` como dependiente del trabajo fallido, así que el
  artefacto con alcance de intento nunca existió y el despliegue moría con "Artifact not
  found" antes de poder llegar a producción. Así es exactamente como v0.9.170
  publicó su versión de GitHub y su paquete npm sin desplegar el relé
  web. `overwrite: true` evita que una reejecución completa, en la que el trabajo de preparación
  sí se ejecuta de nuevo, choque con el artefacto del intento anterior, y la
  puerta de publicación comprueba tanto el nombre como el overwrite.

## v0.9.170 - 2026-09-17

- Consolidación del prompt del sistema. Cada regla ahora tiene un único responsable: la capa
  compartida (`rules/shared/*.md`) es solo política de herramientas y abre con
  `# Tool Calls` (primero el batching; `05-parallel-calls.md`), el rol Lead es
  un solo archivo (`rules/lead/LEAD.md`: comunicación con el usuario, briefing de agentes y
  notificaciones de finalización tras `<!-- tools: agent -->`, tono), y el
  contrato común de agentes es un solo archivo (`rules/agent/AGENT.md`: cadena de
  mando, sin autoverificación, inglés, forma del handoff). `00-general.md`,
  `02-persona.md`, `lead-brief.md`, `00-core.md`, `00-common.md` y
  `75-goal.md` han desaparecido: las frases que sobreviven pasaron al archivo que
  las posee, y las frases que ya declara la descripción de una herramienta (`load_tool`,
  `Skill`, `goal`, aprobación de `memory`, `task wait`, el esquema de `code_graph`,
  la forma de las llamadas a read, el enrutamiento de Git, el enrutamiento de browser/computer) se declaran
  solo allí. La precedencia es por rol: la última solicitud explícita del usuario para Lead,
  el último brief de Lead para los agentes. La regla de preámbulo de Lead ahora lleva
  su motivo (el usuario solo ve tu texto) y pide una línea, no un recuento de
  palabras; la regla de briefing dice que un agente nunca ve la conversación, que
  los hallazgos se sintetizan en rutas, líneas y el cambio exacto ("based
  on your findings" nunca), y que el resultado de un agente nunca se predice.
  Las reglas de acciones destructivas que estaban repartidas en cuatro secciones están en una sola
  sección `# Destructive Actions`. Los archivos de rol (`agents/*/AGENT.md`) eliminan las
  frases de bloqueo/handoff que posee el contrato; `maintainer` gana frontmatter de nombre y
  descripción. Estilos de salida: el encabezado `## Depth` sustituye a
  `## Depth Variation`, y la redacción de los informes de progreso vive solo en las reglas de Lead.
  El workflow Default ya no lleva el párrafo de reviewer-fallback;
  va con el bloque de modo de orquestación que inyectan los modos
  que delegan. Descripciones de herramientas: `edit` ya no apunta a `apply_patch`
  en superficies que lo filtraron, `shell` dice que Git va a `git` solo cuando
  esa herramienta está presente, `read`/`grep` eliminan los límites de bytes que el runtime informa
  de todos modos, `code_graph` indica que `symbols` es el esquema. Los proveedores que
  entregan ellos mismos el recordatorio de ronda (`anthropic-oauth` como mensaje de sistema con alcance de turno,
  `cursor` mediante su relé) declaran `deliversRoundReminder`
  para que el canal del runtime permanezca en silencio: las sesiones de Cursor ya no reciben el
  recordatorio de batching dos veces por ronda. La comprobación de procedencia del aviso de batching
  normaliza los separadores de ruta y acepta un directorio mostrado como prefijo de una
  ruta más profunda en el resultado anterior, de modo que una llamada de seguimiento sobre una ruta que el último
  resultado reveló ya no se lee como una única llamada no relacionada (dos
  falsos positivos por sesión antes). El esquema de ruta de `setup` declara
  `contextPercent` como entero acotado (el ejecutor sigue exigiendo un
  múltiplo de 10) para que Gemini deje de recibir un marcador de enum
  irrepresentable. Las expectativas de pruebas obsoletas que dejó el commit de batching
  se actualizan, y dos pruebas dependientes de tiempo/entorno se hacen
  deterministas. La habilidad de proyecto `gamerscroll-article` queda limitada
  a su proyecto.
- Las versiones de GitHub ahora llevan la sección de CHANGELOG.md de la versión como sus
  notas, seguida del enlace de comparación; el borrador antes dependía de
  las notas generadas por GitHub, que solo listan PR fusionados y dejaban la página
  con un enlace `Full Changelog` desnudo porque Deploy hace commit directamente a main.
- Batching de herramientas: tras tres rondas seguidas de una sola llamada de una misma herramienta cuyas
  llamadas no se necesitaban entre sí (sin argumento tomado del resultado anterior,
  sin paso ordenado tras una mutación; una herramienta distinta reinicia la racha, así que
  read → shell → apply_patch nunca se informa; las esperas de tareas, Computer Use,
  los pasos de navegador y las cargas de esquemas/habilidades nunca cuentan), o una
  ronda de llamadas de la misma herramienta que difieren solo en un campo de array, el runtime añade un
  breve `<system-reminder>` que nombra los argumentos de array de la superficie de herramientas
  de la sesión; se repite cada vez que el patrón reaparece y solo una ronda en batch
  lo borra (registrado como `batching_nudge`). Un `read` de un solo archivo justo después de
  una ronda de grep/code_graph/glob/find que localizó varios archivos recibe de vuelta el
  conjunto localizado con la forma que admite una llamada `read`
  (`[{file_path, offset, limit}, …]`; un read por archivo en la misma respuesta
  en proveedores cuyo esquema de read admite solo cadenas de ruta), registrado como
  `located_sites`: una sesión grabada de Gemini 3.8 Flash localizó archivos con
  grep 13 veces y aun así los leyó ventana a ventana (63 lecturas, 20 de
  28 archivos leídos dos veces o más). Las descripciones de `read` y `grep` ahora dicen
  qué es el batch —todos los archivos y rangos que vas a tocar, antes de editar,
  en una sola llamada— y el pie de la lectura por ventanas pide una lectura más amplia
  en lugar de la siguiente ventana. Las reglas compartidas ahora declaran una vez el orden de trabajo sobre archivos
  (`# Tool Calls`: enumerar solo cuando se desconoce el alcance → localizar
  cada sitio → una etapa de lectura de ventanas `{file_path, offset, limit}`, ≤10 por
  llamada → todas las ediciones en una respuesta → una verificación) y eliminan las
  frases que antes decían partes de eso en tres lugares; las descripciones de `read`,
  `grep`, `edit`, `apply_patch` y `code_graph` se reducen a ese
  contrato (code_graph de ~150 a ~90 palabras), y el marcador de límite inteligente de una lectura
  por ventanas nombra la forma de ventana localizada; una pasada adicional recorta
  la prosa de parámetros que repetía las reglas o detalles internos (`Skill`,
  `find`, `cwd`, `git`, `code_graph.mode`, `grep.path`/`text`,
  `include_noise`, la guía rápida de PowerShell de shell y `timeout_ms`): la superficie de
  herramientas de Lead baja de 13.4 KB a 12.7 KB. Ejecuciones de ocho tareas con GPT-5.6 antes
  y después se mantienen en 8/8 con el mismo número de rondas, tiempo y coste; la
  única regresión encontrada por el camino (una ronda de copia de seguridad para entradas de solo lectura y
  sondeos de `git log` tras recortar dos cláusulas de protección) está restaurada. La
  regla de copia de seguridad ahora dice dónde va la copia —en la misma respuesta que la primera
  inspección, nunca en una ronda propia— porque "inside the first inspection
  call" hacía que GPT-5.6 abriera 2.8 rondas solo de copia de seguridad por ejecución de ocho tareas cuando la
  primera inspección era una llamada `read` o `git`; con la redacción corregida
  no abrió ninguna y agrupó cada copia con esa inspección. El
  recordatorio serial ya no trata un array dentro de una sola llamada como un batch: una
  revisión grabada de Gemini 3.8 Flash ejecutó quince rondas de una llamada, alternando
  llamadas `git` de uno y dos comandos, y el aviso nunca se activó porque cada ronda
  de array reiniciaba la racha. La comprobación de procedencia también recuerda seis rondas
  en lugar de dos, de modo que una lista de archivos de `git diff --name-only` recorrida un elemento
  por ronda ya no hace que cada elemento se tome como derivado de lo que el diff anterior
  mostró. Dos recordatorios de runtime más:
  `late_locating` (una búsqueda tras una lectura que no tomó nada de
  ella) y `located_sites` entregando una ventana por sitio localizado
  —filas `(Lstart-end)` de code_graph incluidas— divididos en varias llamadas read
  pasados diez. Los archivos de política de rutas
  (`rules/routes/*.md`) ahora también declaran un `turn-reminder:` de una línea (leído
  una vez en el bloque `<system-reminder>` final del turno del usuario, antes de la
  primera respuesta del turno) y un `round-reminder:` de una línea junto a sus
  reglas estáticas; el bucle del agente resuelve este último por proveedor/modelo y
  llega al modelo tras cada ronda de herramientas —como mensaje de sistema con alcance de turno de Anthropic
  (`clear_at: next_user_message`) en `anthropic-oauth`, el
  patrón que Anthropic documenta para Claude Fable 5.1, o como `<system-reminder>`
  de runtime tras las rondas de una sola llamada en el resto (`per_round`). El
  recordatorio de Fable 5.1 pasa de una constante de proveedor codificada a los
  archivos de ruta; los historiales grabados bajo la frase anterior la reproducen
  byte a byte. Un archivo, `routes/common.md`, lleva los recordatorios de batching
  de todas las rutas (un archivo sin restricciones es la base; un archivo que nombra
  `models:` o `providers:` se suma a esa línea para sus rutas en lugar de
  reemplazarla) —
  Gemini va una llamada por ronda una vez llegan los resultados de herramientas, Grok
  agrupa llamadas pero nunca usó argumentos de array: sus esquemas de herramientas aplanados
  conservaban solo la rama escalar de cada campo de uno-o-varios
  (`read.file_path`, `grep.pattern`, `git.command`, …). El aplanado de Grok
  ahora conserva la rama de array de esos campos (un valor viaja como array
  de un elemento) y lo indica en la descripción del campo, de modo que el contrato de
  batching también se cumple en ese proveedor. Las reglas compartidas ganan una
  sección `# Parallel Tool Calls` que declara el contrato claramente (sesiones grabadas de
  Gemini 3.8 Flash emitieron una llamada por ronda en 105/105 rondas;
  con la sección en su lugar una ejecución headless agrupó cuatro archivos y git en
  una respuesta). Las reglas ligadas a proveedor/modelo se cargan desde `rules/routes/*.md`
  mediante frontmatter `providers:` / `models:` y se renderizan tras las reglas
  compartidas en BP1.
  `MIXDOG_ANTIGRAVITY_DUMP_DIR=<dir>` escribe cada cuerpo de solicitud de Antigravity
  (contenidos, herramientas, configuración; nunca cabeceras ni tokens) para inspección del tráfico,
  el equivalente en Gemini de `MIXDOG_OAI_WS_DUMP_DIR`; `mixdog exec` también
  pasa `MIXDOG_XAI_CACHE_TRACE` y `MIXDOG_XAI_RESPONSES_CACHE_SCOPE`
  para sondeos de caché de xAI.
- Las solicitudes de xAI Responses ya no envían un `prompt_cache_key` por sesión de forma
  predeterminada (`MIXDOG_XAI_RESPONSES_CACHE_SCOPE` ahora es `none` por defecto, el cuerpo
  literal de Grok Build): la clave de sesión dividía la caché del servicio en carriles
  y medía dos rondas en frío por ejecución frente a una, y ninguna reutilización de
  prefijo entre sesiones. `session` y `prefix` siguen siendo seleccionables.
  `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED` anula el modo de llamada a funciones
  de Antigravity para ejecuciones A/B, y
  `benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs` informa de
  las tasas de llamadas múltiples y de argumentos de array por modelo a partir de `agent-trace.jsonl`.
- `mixdog exec` vincula la cuenta OAuth seleccionada en el pool de
  cuentas de proveedor del host (la credencial que escribe hoy el inicio de sesión), recurriendo a la
  única credencial heredada; antes solo se aceptaba el archivo heredado o una
  `*_CREDENTIALS_PATH` explícita, así que los hosts solo con pool fallaban con
  "credentials are unavailable". `mixdog exec` además ya no se queda 2–4 minutos
  después de su respuesta antes de emitir `result`: la eliminación de la raíz intacta se reintentaba
  en Windows durante todo el presupuesto de rmSync (50 reintentos lineales ≈ 128s, dos veces cuando
  la ruta del postmaster la reejecutaba) mientras el handle SQLite del registro de uso y el `pg.log`
  de un daemon de memoria en cierre seguían abiertos. El registro se cierra
  antes de la eliminación y exec pasa un presupuesto de 10 reintentos (≈5.5s)
  (`cleanup({ rootRemovalRetries })`); una raíz rezagada se deja al
  barrido periódico de huérfanos en lugar de al llamante.

## v0.9.169 - 2026-09-16

- Code Tidy: Instalar ahora descarga los motores principales (Biome, ruff, shfmt,
  shellcheck, PSScriptAnalyzer) con progreso, y la tarjeta integrada lista
  cada motor con su versión, lenguaje, origen y tamaño; los motores recogidos
  más tarde por un proyecto aparecen en la misma lista. Los motores que faltan en el momento de tidy
  se descargan automáticamente por defecto (`tidy.downloads` sigue respetando `ask` y
  `never`). PSScriptAnalyzer es una descarga gestionada verificada con sha256 desde la
  PowerShell Gallery en lugar de un módulo solo del host, y C# obtiene un ejecutor real
  de dotnet-format. Correcciones: se analizan las cabeceras de diff de rustfmt 1.9 y las rutas `\\?\`,
  los informes grandes de Biome ya no colapsan a cero hallazgos cuando la
  salida llega en fragmentos, la capacidad de corrección se clasifica mediante `biome explain`, y
  la regla de comentarios de historial solo elimina comentarios que son enteramente historial
  y nunca se extiende más allá del comentario (podía borrar la siguiente sentencia).
- Las filas de la barra lateral comparten una etiqueta de estado junto al título en elementos integrados,
  plugins, habilidades, servidores MCP, programaciones, webhooks y agentes: nada cuando
  está activado, y en otro caso `Not used`, `Not installed`, `Installing… N%`, `Failed`
  o `Not connected`. Los agentes desactivados conservan su línea de modelo.
- FastDirect se niega a reempaquetar o instalar un `app.asar` cuya clausura de
  dependencias de producción esté incompleta y recurre a una compilación completa, de modo que un
  actualizador roto (`Cannot find module 'graceful-fs'`) ya no lo hereda
  cada actualización incremental.
- Los workers de agentes que fueron recolectados ya no son resucitados por los escaneos de sesión
  ni por la lista de agentes del escritorio; las sesiones terminadas que se vuelven a registrar conservan su
  hora de finalización real, de modo que los arrendamientos caducan en lugar de reiniciarse cada hora.
- Los modos de orquestación `none`, `focused`, `balanced` y `swarm` sustituyen al
  workflow Solo y se eligen por sesión; los ajustes están localizados.
- Escritorio: los enlaces de rutas locales en markdown se abren en el editor, y el editor
  abre archivos fuera del proyecto.
- Browser Use serializa las instantáneas por página y refuerza las rutas de espera y
  captura.
- Computer Use: un renderer de overlay congelado se retira y reemplaza, el estado de
  recuperación de entrada sobrevive al cambio, y los fixtures del overlay ya no terminan
  antes de tiempo en una máquina de una sola pantalla.
- Shell: los hosts de PowerShell ya no bloquean de forma rígida `grep`, `sed` y `awk` en la
  comprobación previa; la descripción de la herramienta enruta en su lugar el trabajo de las herramientas dedicadas. Las reglas,
  habilidades, README y el nuevo `docs/context-efficiency.md` están actualizados.
- El repositorio se formatea con Biome 2.5.13 (`biome.json` fija el
  estilo existente), rustfmt, dotnet-format y PSScriptAnalyzer; se eliminan las importaciones
  sin usar, los helpers muertos y las exportaciones usadas solo dentro del archivo.

## v0.9.168 - 2026-09-16

- Cerrar una sesión de Computer Use siempre envía su propia solicitud de liberación. La
  liberación especulativa del temporizador de inactividad solía heredarse cuando aún estaba en
  curso, de modo que una liberación temprana rechazada podía dejar fijados los claims de worker y ventana
  de la sesión que se cerraba hasta reiniciar la aplicación.

- Overlay de Computer Use: dos controles, Detener y Reanudar. El botón de pausa ha
  desaparecido (tocar el escritorio ya cede el control al usuario); la píldora ahora
  muestra por qué un control no está disponible o por qué falló una solicitud en lugar de
  reaccionar en silencio. Detener recupera un fallo de limpieza latente una vez que todos los workers
  de entrada han terminado, de modo que el host ya no necesita reiniciar la aplicación, y la
  confirmación de salida del worker espera hasta 5 segundos en lugar de 1.
- Computer Use captura una ventana desde su propia superficie renderizada en lugar de
  copiar el escritorio, con un presupuesto de captura acotado; una liberación de recursos
  sin confirmar retira ese worker. El teclado en segundo plano y type se comprueban
  antes de enviar cualquier entrada, de modo que una ruta no admitida no hace nada. Un nuevo
  comando espera hasta que se confirma la liberación de la sesión anterior. Detener también
  espera a la cancelación del turno del agente, independientemente de la limpieza de entrada nativa.
- Las esperas de Browser Use respetan la cancelación y se niegan a mezclar una URL con texto de un
  documento posterior; la restauración fallida de una captura de página completa es terminal. Los selectores
  CSS conservan los espacios interiores, rechazan conjuntos de coincidencias demasiado grandes y
  direccionan cada coincidencia de forma única. Las descargas concurrentes comparten un total de bytes
  por sesión; los avisos de aprobación describen acciones y direcciones, nunca valores de formularios.
- Code Tidy es un integrado instalable, como Office: Ajustes → Integrado
  lo instala y lo activa, y la habilidad `code-tidy` maneja la herramienta `tidy`.
  Scan detecta los lenguajes de un proyecto y resuelve cada formateador o linter
  desde la configuración del proyecto, luego binarios locales del proyecto, PATH, o una
  descarga gestionada verificada con sha256 (ask, auto o never). Ejecuta Biome, ruff, clang-format,
  shfmt, shellcheck, StyLua, gofumpt, dprint, Air y Mago, además de las herramientas de la cadena
  rustfmt, gofmt y PSScriptAnalyzer, y aplica paquetes estructurales
  (eliminación de comentarios de historial, `debugger`, catch vacío, marcadores TODO) en 31
  lenguajes. `fix` es una simulación salvo que se indique apply, y las escrituras pasan por el
  mismo flujo que otras ediciones. Las licencias de los motores se incluyen con la herramienta.
- Los callers y callees de `code_graph` proceden de sitios de llamada analizados, no de la búsqueda de
  texto; las referencias con forma de llamada también usan esos sitios. Un binario de grafo
  más antiguo que no puede emitirlos falla con un remedio de reconstrucción en lugar de una respuesta
  vacía. Las filas del esquema usan un único vocabulario de tipos, marcan exportaciones, muestran
  firmas y anidan los miembros bajo su padre. `find_symbol` prefiere un
  archivo de implementación a un `.d.ts` acompañante e informa cuando la
  declaración está fuera de los archivos solicitados. Los tokens de identificador proceden de
  el árbol de análisis, así que un nombre que aparece solo en un comentario ya no cuenta
  como referencia. Solidity, Haskell y HCL se suman al conjunto de extracción con
  aristas de importación (24 lenguajes de extracción, 31 analizados). Los datos de sitios de llamada viven en
  una caché auxiliar para que la caché principal del grafo mantenga el mismo tamaño.
- El binario nativo del grafo incorpora tree-sitter 0.27 y ast-grep 0.45.3, añade los
  modos `--scan`, `--langs` y `--outline`, y extrae símbolos, importaciones
  y tokens de identificador a partir de reglas YAML.
- El esquema alternativo por grafo del editor de escritorio analiza las nuevas filas de símbolos en
  un esquema anidado con iconos de tipo.
- Las preguntas de estructura (exportaciones, firmas, miembros, callers, importadores) van
  a `code_graph` antes que a `read` o `grep`; la redacción de paralelismo del
  flujo de herramientas es una sola regla.
- El mantenimiento de la memoria ya no promueve resúmenes de conversación a instrucciones
  permanentes: no hay un tercer ciclo. El ciclo 2 revisa el historial de búsqueda en busca de
  duplicados y linaje sin reescribir resúmenes. La memoria permanente sigue
  curada por el usuario mediante `memory`; `recall` busca en todo el historial por defecto,
  incluidas las filas archivadas previamente.
- El uso de Antigravity Gemini muestra ventanas compartidas de 5 horas y semanales del
  resumen de cuota de la cuenta, no contadores de catálogo por modelo, y las solicitudes usan el
  canal diario sin conmutación automática de host.
- El panel Agentes expande solo las filas que abres, muestra un recuento de descendientes en
  el lead, y dice "Waiting for agents" mientras los descendientes siguen
  trabajando en lugar de tratar al padre como inactivo o completo.
- El compositor ofrece una pequeña paleta de comandos de barra para los comandos frecuentes
  (`/new`, `/model`, `/compact`, `/context`, `/goal`, `/inherit`, `/fast`);
  el registro completo sigue funcionando cuando se escribe directamente.
- Las menciones de archivos en la conversación siguen siendo texto sin formato hasta que la ruta se confirma
  en el Proyecto propietario; las carpetas y los documentos siguen abriéndose en el SO, y las
  aperturas del editor pasan un token de acceso.
- La lista de uso de la barra lateral alinea etiquetas de proveedor, medidores, porcentajes y
  horas de reinicio en una sola cuadrícula; el catálogo de modelos conserva siete recientes.
- Una sesión nueva espera a que terminen los guardados de ajustes pendientes, y las herramientas MCP
  que salieron del catálogo actual no se llaman a mitad de turno.

## v0.9.167 - 2026-09-15

- El inicio de sesión informa de qué herramientas de shell comunes están presentes ("Shell tools
  at startup"), medidas en el shell de inicio de sesión en POSIX y en el PATH del proceso
  en Windows, de modo que un modelo ya no adivina `python` frente a `python3` ni llama a
  `file` donde no existe; una respuesta desconocida no muestra nada.
- `read` renderiza una sola vez las ventanas superpuestas de un archivo, ya no informa de rangos
  de edición no leídos como ya entregados, y nunca hereda una marca obsoleta de
  cuerpo completo entregado tras cambiar un archivo; las lecturas de array respetan su opción
  sin stub y la descripción indica los límites reales de salida.
- `git` ejecuta como array ordenado (hasta 10) los comandos encadenados con `&&` en lugar de
  rechazarlos, y reconoce repositorios bare.
- La caché de lectura de sesión respeta la lista de herramientas permitidas, detecta cambios solo de `ctime`,
  nunca almacena un cuerpo capturado antes de un cambio a mitad de lectura, mantiene separadas
  las pistas de offset públicas y heredadas, y cubre las lecturas de array públicas.
- Los arrays de `web_search` mantienen marcados como errores los fallos parciales y totales.
- Las reglas y las descripciones de herramientas integradas son más cortas con el mismo comportamiento: la
  descripción de `shell` lleva el mapa comando→herramienta y prohíbe nombres de herramientas como
  comandos de shell; la guía de `timeout_ms` cubre las comprobaciones desechables; la guía de Lead
  que solo se aplica con la herramienta `agent` se omite de los workflows sin delegación;
  las reglas piden en una sola respuesta cada acción independiente que la evidencia actual
  requiere, parchear directamente a partir de evidencia decisiva, una
  muestra antes de la lógica de análisis, y porciones acotadas para datos grandes o binarios.
- Runtime de escritorio sincronizado con el trabajo actual del arnés de navegador y equipo,
  y pruebas de contrato de herramientas reforzadas en consecuencia.

## v0.9.166 - 2026-09-14

- Studio reconoce la cuenta de ChatGPT seleccionada tras el inicio de sesión del proveedor y
  los cambios de cuenta, usando la misma ruta de credenciales que el chat sin recurrir a
  las credenciales de otra cuenta.

## v0.9.165 - 2026-09-14

- El dock de Control de código fuente mantiene su ventana de filas ligada a la lista en vivo: un
  dock reconstruido (cambio de pestaña, de superficie de primera ejecución a lista) ya no se desplaza a
  filas vacías.
- Los recursos de versión de macOS se suben mediante el script de borrar-y-reintentar en ambas
  arquitecturas, de modo que una ejecución de recuperación ya no falla por un recurso que ya
  existe en el borrador oculto.
- Puerta de publicación: todos los carriles pasan en verde en los runners alojados. Linux instala
  NanumGothic para PDF en hangul y el LibreOffice actual para las revisiones
  renderizadas; la comprobación de cursor de Windows fija su preferencia de movimiento; las expectativas
  de las pruebas siguen los contratos distribuidos.

## v0.9.164 - 2026-09-14

- Se compactan las reglas compartidas y de Lead y las descripciones de las herramientas integradas al
  mismo comportamiento con menos tokens; la descripción de `shell` conserva solo su rol,
  el límite con las herramientas dedicadas de archivos/búsqueda/Git, y el contrato de
  tareas en segundo plano.
- Las ejecuciones headless (`mixdog exec`) declaran que ningún usuario interviene a mitad de la ejecución: la
  solicitud se trata como aprobada y se lleva a cabo hasta el final antes de informar,
  en lugar de detenerse a hacer una pregunta que nadie puede responder.
- `apply_patch` escrito en el shell ya no se reenvía al motor de parches;
  el modelo llama directamente a `apply_patch`/`edit`.
- Un Objetivo detenido se retira como uno completado: el siguiente prompt del usuario
  lo archiva, y confirmar una detención lo archiva de inmediato.
- Las estadísticas de uso atribuyen tokens y coste medidos por solicitud en el registro,
  y el explorador de uso del escritorio muestra el desglose resultante.
- Correcciones del protocolo del proveedor Cursor.

## v0.9.163 - 2026-09-10

- Se perfeccionan la localización de la interfaz, la selección del idioma de inicio, los menús nativos y
  el formato traducido; se mantiene actualizado el arranque de idioma web entre actualizaciones.
- Se refuerzan la propiedad de entrada de Computer Use y las comprobaciones de solo observación, se confirman
  los destinos de texto de Electron antes de escribir, y se mejora el manejo del cursor y de las sesiones.
- Se mejoran la búsqueda nativa de archivos y las lecturas por rango, y se evita que cálculos en curso
  invalidados o cancelados vuelvan a poblar la caché de resultados.
- Se incluyen benchmarks de búsqueda, cobertura de regresión, auditorías de localización y
  entregables generados de proyectos y documentos.

## v0.9.162 - 2026-09-09

- El diálogo Establecer un objetivo se abre centrado en el panel cuyo compositor lo lanzó,
  atenuando solo ese panel; los paneles hermanos permanecen visibles y utilizables y la barra
  de título ya no se atenúa. Fuera de un panel recurre a la capa de la ventana.
- Un panel con foco ya no cubre el tirador de división de su propio borde: un panel
  de navegador (o cualquier panel con foco) se puede redimensionar de nuevo desde su borde izquierdo/superior.
- Web fetch informa de una etapa que agota el plazo total como
  `FETCH_TIMEOUT` en lugar de `STAGE_TIMEOUT`.
- Computer Use usa por defecto la entrega en segundo plano para la entrada semántica admitida;
  `foreground_unavailable` ahora pide al usuario que active la ventana de destino
  en lugar de describir un fallo de bloqueo de primer plano.
- La ejecución de la versión v0.9.162 se detuvo en la puerta de pruebas y no publicó nada; sus
  notas siguientes se entregan con esta versión.

- Mixdog ahora tiene licencia Apache-2.0 en lugar de MIT. Los componentes
  de terceros conservan sus licencias existentes y avisos de atribución.

- Browser Use y Computer Use preguntan una vez por sesión antes de su primera llamada
  en vivo. La primera llamada `browser`/`browser_devtools` o `computer` que hace un modelo
  en una sesión pasa por el aviso de aprobación de herramientas con la acción que quiere
  realizar; permitirla cubre el resto de la sesión, rechazarla devuelve el
  motivo al modelo con la instrucción de no reintentar, y un reinicio vuelve a
  preguntar. Las sesiones sin interfaz de aprobación (headless, propiedad de un agente) no se someten a esta barrera.
  `setup set_first_use_approval name:browser|computer enabled:false` lo desactiva
  por capacidad, y `MIXDOG_BRIDGE_FIRST_USE_APPROVAL` lo anula por
  proceso.

- Browser Use integra dos gestos en los que tiene al lado. Una casilla o un
  radio se establece con `fill` y `checked` en lugar de `text` —para un control,
  un elemento de `fields` o un paso de `sequence`—, así que la acción `check` separada ha
  desaparecido; y `forward` ha desaparecido, ya que la instantánea anterior ya mostraba la
  URL a la que hacer `navigate`, mientras que `back` sigue siendo un gesto. `locate` y `extract`
  se mantienen: el primero es una búsqueda visual (por píxeles) sin equivalente semántico, el
  segundo lee filas entre marcos y shadow roots abiertos a los que `evaluate`
  no llega.

- `capture` de Computer Use elimina sus parámetros `quality`, `maxWidth` y `max_ocr_words`:
  se aplican los valores predeterminados ajustados del host (calidad JPEG, ancho de reducción y un
  límite de palabras OCR que el presupuesto de elementos ya acota), y el detalle ilegible es un
  `zoom` en lugar de una recodificación. Los filtros de elementos (`query`, `role`,
  `visible_only`, `include_noninteractive`, `continuation`) y la geometría de movimiento de
  `window` ahora dicen lo que hacen en lugar de ir en el esquema sin explicación.

- Browser Use y Computer Use declaran su peldaño de la escalera de herramientas allí donde
  el modelo decide. La descripción de `browser` abre con "last resort: prefer
  web_fetch, an MCP tool, or a CLI in shell", `computer` con "last resort
  after an MCP tool, shell/CLI, and Browser Use; never a stand-in for a page
  action browser refused", y las reglas compartidas y ambas habilidades llevan la misma
  escalera, de modo que un servicio con API o CLI se alcanza a través de ella en lugar de
  una pantalla. Ninguna descripción creció: la escalera sustituyó redacción que las habilidades
  ya poseían.

- Browser Use son dos herramientas. `browser` conserva el trabajo diario con páginas —navigate,
  snapshot, read, click, fill, formularios, diálogos, pestañas, descargas, lecturas de consola y
  red—, mientras que los controles de desarrollador `emulate`, `cookies`,
  `storage`, `intercept`, `init_script` y `performance` pasan a la herramienta diferida
  `browser_devtools`, que maneja las mismas páginas e inicios de sesión y
  carga su esquema en su primera llamada. El esquema diario elimina los 33
  campos que solo usaban esas acciones (atributos de cookies, geolocalización, limitación de CPU,
  cuerpos de intercept, opciones de trazas), las notas de campo de cada herramienta nombran
  solo sus propias acciones, y una llamada que llega a la herramienta equivocada se rechaza
  indicando la herramienta a llamar. El host, su registro de acciones, la política de aprobación y
  el arnés de integración mantienen el único contrato de acciones compartido.

- Los esquemas de herramientas integradas declaran solo contratos. Las descripciones y notas de campo
  de las herramientas `office`, `computer`, `media` y `setup` eliminan las frases de método y
  política que sus habilidades ya poseen —batching, cuándo hacer snapshot o
  `describe`, corregir una auditoría en el mismo turno, reutilización de `design.content`, manejo de
  macros, no reorganizar, que el contenido de pantalla nunca autoriza una acción,
  sondeo de vídeo, el procedimiento de aprobación de borrado—, lo que elimina unos 2.2 KB
  (office −878 B, computer −492 B, media −432 B, setup −424 B) de la superficie de herramientas
  enviada en cada turno. Las habilidades pptx, xlsx y pdf ahora llevan las
  reglas que vivían solo en el esquema (un batch de operaciones conocidas,
  `describe` solo para un campo desconocido, contenido de documento no confiable), y la
  habilidad computer-use declara el contrato de llamada una vez en lugar de repetir cada
  frase del esquema.

- Browser Use necesita menos llamadas por tarea. `click`, `fill`, `type`, `select`,
  `hover`, `upload` y `scroll` —y cada elemento de `fill.fields` y paso de
  `sequence`— aceptan un `target` sin instantánea (`{role, name}`, `{name}`
  o `{selector}`) en lugar de un `ref`: el host observa la página por sí mismo,
  actúa solo sobre exactamente una coincidencia (varias coincidencias de subcadena se resuelven en la
  única literal), y un destino ambiguo falla con los candidatos y
  sus refs nuevas. `query` en `snapshot`, `read` y `wait` hace coincidir palabras clave
  separadas por espacios con OR (las coincidencias de todas las palabras van primero) y admite
  expresiones regulares `/pattern/i`, y un filtro que no coincide con nada indica
  cuántos elementos o caracteres estaba filtrando. Los controles transparentes o con
  pointer-events:none ya no se rechazan de plano: una casilla oculta
  se pulsa a través de su etiqueta, y la protección del destino de entrada acepta
  la activación de la etiqueta. `fill` en un editor `contenteditable` reemplaza el
  contenido como entrada tecleada sobre un seleccionar-todo en lugar de sobrescribir su DOM.
  Las respuestas indican "No observable change" cuando un gesto dejó intactos el documento, la URL
  y los valores de los controles, `brief:true` lista solo los elementos nuevos
  o cambiados desde la observación anterior, los errores de consola se informan una vez
  cuando son nuevos, y una postcondición que ya se cumplía es una advertencia en lugar de un
  error. Las instantáneas marcan los inputs de archivo con `file-input`, `accept=…` y
  `multiple`; las capturas de página completa anclan los elementos fijos y sticky en el flujo
  para la captura; y las cookies de sesión se almacenan cifradas con el llavero
  del SO y se restauran al iniciar, de modo que los inicios de sesión sobreviven a un reinicio de la aplicación.

- Los elementos sobre el campo de entrada del prompt —cápsula de Objetivo, progreso del runtime, aprobación
  de herramientas, la barra de contexto del borrador y la ranura de revisión del turno— ahora vive en un solo
  `ComposerDock`, y la transcripción ya no oscila cuando esos elementos se resuelven:
  la ranura de revisión permanece reservada mientras la primera lectura autoritativa del worker de un ámbito
  está en curso, de modo que un diff que llega después de mostrarse la transcripción ocupa la
  geometría existente en lugar de volver a redimensionar el viewport. El espacio liberado
  nunca se retiene con un temporizador. El host de escritorio también deja de releer una sesión
  entera tras cada prompt aceptado (la recuperación "missing baseline" del
  registro del daemon): una respuesta o trama de carril que repite la revisión que la proyección
  ya tiene es estado aplicado, no una línea base cruzada. Las alternancias de montaje/desmontaje
  de la cápsula de Objetivo se pueden atribuir con `MIXDOG_DESKTOP_PERF=1`.

- Una cápsula de Objetivo ya no aparece y desaparece por sí sola. Dos rutas de publicación
  producían el parpadeo: el pulso de ruta de 2s leía el registro de Objetivo sin procesar mientras
  el archivo de entrada del usuario de un Objetivo completado aún se estaba escribiendo, de modo que la
  cápsula retirada volvía durante un fotograma; y en Windows una lectura de Objetivo que
  caía dentro del reemplazo atómico del archivo (`EPERM`/`EACCES`/`EBUSY`, o la propia
  escritura en curso del runtime) aparecía como "sin Objetivo" durante ese fotograma. Las
  publicaciones de ruta ahora leen el Objetivo a través de la máscara del archivo de continuación de goal,
  y el almacenamiento de Objetivo responde a esas lecturas desde el último registro confirmado.

- Browser Use ya no se detiene a pedir aprobación: el diálogo de escritorio "Allow once"
  que protegía `upload` y el `clear` compartido de cookie/localStorage ha desaparecido, el
  campo `confirm` sale del contrato de la herramienta browser, y la habilidad browser-use
  elimina sus reglas de visto bueno en la conversación. `MIXDOG_BROWSER_CONFIRM_ACTIONS`
  y `MIXDOG_BROWSER_DENY_ACTIONS` siguen siendo la única forma de confirmar o rechazar
  acciones con nombre.

- La columna de lectura del panel —compositor, transcripción y el dock de Studio— ya
  no espera a que un panel de 1536px se ensanche: desde 768px mantiene 800px hasta
  que el panel supera los 1000px, y luego sigue el 80 % del panel hasta el límite de
  1000px en 1250px, de modo que las ventanas de 1536/1680 y 1920 con un panel lateral abierto
  dejan de quedarse en 800px, y un divisor que cruza el escalón ya no hace saltar
  la columna 200px.

- El panel Sesiones empieza con dos filas de lanzamiento fijas, `New task` y
  `New Studio`, ancladas sobre la lista de sesiones. Por tanto Studio sale del
  carril de actividad: su entrada de carril solo de lanzador y las excepciones de lanzador en
  el diseño de vista lateral, el dock del panel y las alternancias del dock se retiran, y un diseño
  de carril guardado elimina el id `studio` al cargar.

- El destino Workflows del carril de actividad se integra en el panel Proyectos: una
  barra de herramientas `Project | Workflow` —el selector de secciones del panel Extensiones, ahora
  compartido como un componente `SidebarSectionToolbar`— alterna entre la lista de
  proyectos y los paquetes de workflows, agentes predeterminados y definiciones de agentes; el
  `+` del encabezado sigue a la pestaña Project; `/workflow` y `/websearch` abren la
  pestaña Workflow; y un diseño de carril guardado elimina la vista `workflows` retirada
  al cargar.

- El kit de la habilidad pptx gana un vocabulario de diseño al estilo de los sistemas de diseño
  basados en tokens: `palette()` deriva tres intensidades de línea (`lineSubtle`,
  `line`, `lineStrong`) y cuatro colores de estado (`T.state.positive | warning |
  critical | informative`, cada uno como `solid` / `weak` / `text`, con contraste
  garantizado y mantenidos por debajo de la banda saturada del revisor para que una columna de veredicto
  nunca active `accent_hue_overuse`); cada distancia se sitúa en una escalera de espaciado
  (`SPACE`) nombrada por relación (`GAP.bind` / `within` / `between`, `GUTTER`,
  `PAD`, `M`); cada rol de texto lleva un interlineado fijo; los portadores repetidos
  (badge, callout, serie de chevrones, stat, tabla) leen su anatomía de `SPEC`
  con variantes de `tone`, un paso de escala `stat` y un helper `statBand()`; los iconos
  se asignan a cuatro bandas de tamaño; y un nuevo `references/writing.md` fija las reglas de frase,
  registro, número, fecha, dinero, unidad y espacio de traducción, enlazado
  desde las habilidades docx y xlsx. Cada portador de spec firma su forma, y el
  recibo de composición lee las firmas de vuelta (`slides[].specs`,
  `deck.specs`: recuento, diapositivas, variantes, anatomías) de modo que un portador cuyo tamaño
  de texto o tipografía derivó entre diapositivas aparece como una segunda anatomía.

- Los tokens de diseño de Office derivan los mismos cuatro colores de estado (`positive`,
  `warning`, `critical`, `informative`, cada uno con un campo `Weak` y un paso
  `Text`, con contraste comprobado frente al lienzo, el panel claro y el campo);
  las puertas de decisión de docx y xlsx dibujan Release y Stop con los estados positivo y
  crítico en lugar de un tinte literal y el segundo acento, y el `calloutTone` de una sección de
  `compose_document` coloca su callout sobre un estado.
  El área de impresión de un panel de `compose_sheet` ahora sigue al panel de decisión,
  de modo que una puerta Stop en una columna más allá del lienzo ya no se corta de la
  página renderizada y exportada.

## v0.9.161 - 2026-09-06

- Las auditorías de Office miden Arial, Helvetica, Times New Roman, Courier New,
  Calibri, Cambria y Georgia en sus tipografías abiertas métricamente compatibles
  (Liberation, Arimo/Tinos/Cousine, Carlito, Caladea, Gelasio) siempre que
  el original no esté instalado, en lugar de informar de que la fuente no está disponible
  y aproximar el ajuste: una máquina Linux con las tipografías Liberation ahora
  audita una presentación igual que Windows. El paquete raíz gana los carriles `test:slow` y
  `test:live`, y los carriles de runtime de CI instalan las tipografías Liberation.

- Los commits de Control de código fuente toman un resumen escrito a mano más una descripción
  opcional: los preajustes de mensaje de commit, las comprobaciones de formato, el autocompletado y la generación
  con IA salen de la tarjeta Git y GitHub y del formulario de commit, y las preferencias heredadas
  `desktop.git` no se leen ni se escriben.

- Computer Use elimina el editor de autorización del lado de los ajustes (bloqueo de ventana y
  acción, caducidad): sigue sin restricciones por defecto con las protecciones permanentes —
  protecciones de entrada, manejo de elevación, toma de control del usuario, protecciones del entorno—
  y un archivo de autorización guardado ya no puede caducar hasta producir un
  bloqueo. El estrechamiento en proceso sobrevive para un host embebido mediante
  `MIXDOG_COMPUTER_POLICY_FILE` y `host.updateAuthorization`, no se persiste nada,
  y la exportación de diagnósticos de fallos se mantiene. La herramienta gana
  `wait_for_user`: cuando el usuario toma el control, el modelo espera un
  intervalo acotado y captura un estado nuevo después en lugar de adivinar
  los permisos.

- Cada tarjeta de Extensiones e Integrados abre el mismo diálogo de detalle: placa de
  identidad y título, secciones con un mismo ritmo, un pie de diálogo con acciones jerarquizadas y la
  acción destructiva a la izquierda, un único estilo de botón de acción; y los diálogos de
  añadir/editar de Proyectos se suman. La tarjeta Git y GitHub lleva la cuenta de GitHub
  (inicio de sesión de gh por código de dispositivo); la tarjeta de Proveedor local
  lista los modelos instalados con tamaño, contexto y estado de ejecución, una sección
  Carga de modelos para la descarga por inactividad, y datos en vivo (compilación del runtime, GPU,
  memoria libre, servidor), mientras que la reparación y la verificación siguen guiadas por el chat
  a través de la habilidad local-provider. Los datos de estado/plataforma salen de los diálogos
  porque el control del encabezado y la insignia de la lista ya los indican. Las
  hojas de estilo de extensiones se dividen en `extension-list.css`,
  `extension-dialog.css`, `extension-editors.css` y `rail-controls.css`.

- Objetivo: reanudar un Objetivo en pausa e iniciar su tarea aprobada son una sola escritura
  duradera: `resume` acepta actualizaciones y adiciones de tareas, marcar una tarea
  `in_progress` reanuda el Objetivo, y la mera contabilidad nunca concede
  aprobación. El estado de un Objetivo en pausa llega al modelo cuando se prepara la
  solicitud, tras la hidratación, en lugar de un recordatorio puntual en la respuesta del usuario,
  de modo que ningún turno puede perder el hecho de que un Objetivo está esperando.

- Los teléfonos sincronizan sus vistas al reconectar: tras el handshake seguro el
  navegador pide al escritorio una línea base coherente de sus sesiones abiertas
  (instantánea, lista de sesiones, pool de agentes, estados de sesión) y las publicaciones en vivo
  se retienen hasta que llegue, de modo que un teléfono reconectado ya no pinta una
  transcripción obsoleta ni pierde el final de un turno. La transcripción entregada a los teléfonos
  omite el material de reproducción del proveedor tanto en deltas como en líneas base.

- La creación de tareas nuevas sobrevive a una conexión remota caída: cada solicitud
  lleva un recibo duradero, de modo que un reintento tras un tiempo de espera o una reconexión cae en
  la misma sesión reservada en lugar de crear un duplicado, y el observador del
  almacén de proyectos se recupera por sí solo y reconcilia el catálogo mientras está
  caído.

- Las conversaciones y las barras de pestañas se muestran sin saltos: una transcripción visitada
  se muestra una vez que sus filas visibles y su desplazamiento final coinciden entre fotogramas (acotado por
  un segundo, de modo que el streaming o una fuente lenta nunca la ocultan), y una barra de pestañas
  decide el desbordamiento a partir del diseño de destino en lugar de una pestaña a medio crecer.

- Las acciones del catálogo de Proveedor local (`searchLocalProviderModels`,
  `inspectHuggingFaceModel`, `registerHuggingFaceModel`) existen en la
  superficie de sesión en la que el daemon las resuelve, de modo que una llamada de setup enrutada por
  el escritorio ya no falla como acción de sesión no disponible.

- Los catálogos de idioma de la interfaz de escritorio vuelven a estar en sintonía con el renderer: las cadenas
  que las vistas de control de código fuente y los comandos de barra leen mediante `t()` faltaban
  en todos los catálogos (la pestaña decía "History" en coreano), las frases en coreano del paquete
  de traducción heredado retirado se migran a `ko.json` de modo que las etiquetas
  dinámicas ("Ln 42", "Callers of …") se traducen de nuevo, y las cadenas de menús
  y diálogos nativos se generan a partir de los mismos catálogos. El coreano está
  completo; los otros diez idiomas recurren al inglés para las frases más nuevas
  hasta que se traduzcan.

- La compilación del importador de navegador reemplaza una copia upstream a medio escribir bajo
  TEMP en lugar de fallar con ella. Arnés de pruebas: las suites del renderer pueden importar
  módulos que arrastran una hoja de estilos de función (una importación `.css` se resuelve en un
  módulo vacío bajo Node), la comprobación de importación del daemon del artefacto compilado se ejecuta en
  el carril live tras una compilación, y los fixtures de rutas del almacén de ajustes se resuelven
  en la gramática de rutas propia del host.

- La habilidad y el runtime de pdf adoptan la disciplina de inspeccionar primero de las
  habilidades de PDF de referencia. Lectura: una instantánea informa `encrypted` y
  `passwordRequired` en lugar del propio error de pdf-lib, `open`/`snapshot` con
  `password` leen el texto de un archivo bloqueado para esa llamada sin conservar la
  contraseña, toda edición en un archivo cifrado apunta a `secure` → decrypt,
  las páginas llevan su tamaño y rotación, los marcadores vuelven bajo `outline`
  con la página que abre cada uno, y la extracción de texto (instantáneas de office, adjuntos
  del chat, la herramienta read) conserva los finales de línea como saltos de línea para que los párrafos y
  las filas de tabla sobrevivan. Formularios: los campos exponen el tipo
  `text|checkbox|radio|dropdown|optionlist`, `options`, `readOnly` y
  `multiline` que necesita un rellenado; `fill_form` nombra un campo u opción desconocidos
  junto con lo que existe e informa `filled`; `add_form_field` y
  `create` aceptan `optionlist`, `required`, `readOnly`, `maxLength` y
  `fontSize`; el lint señala un recuadro demasiado pequeño para usarse (`formIssues` en create,
  `field_too_small` en `issues`); `preview_fields` escribe una copia con cada
  campo y cualquier recuadro propuesto delineado y nombrado para que un renderizado muestre la ubicación
  antes de rellenar; un desplegable o lista con opciones en coreano ya no
  falla en la creación porque el widget se pinta con la tipografía incrustada desde
  el principio; y un campo multilínea usa por defecto 11 pt en lugar del
  tamaño automático de pdf-lib, que dibujaba la primera línea enorme y descartaba el resto.
  Tipografías: `create`, `add_text`, `watermark`, `fill_form` y OCR incrustan
  una fuente Unicode instalada por sí solos cuando el texto es coreano, CJK,
  cirílico o griego (`pdf-fonts.mjs`; `fontPath` sigue eligiendo; `detect`
  nombra la tipografía como `portable.pdfUnicodeFont`). Escritura: `create` ajusta
  la prosa sin espacios por carácter, respeta `\n`, ajusta las celdas de tabla y hace crecer
  las filas, repite el encabezado tras un salto de página, numera la salida de varias páginas,
  y acepta `columnWidths`, `level` de encabezado, `align` de imagen, `orientation`,
  `footer` y más tamaños de página. Edición: `merge_pdf` acepta `sources:[path | { path,
  pages, title }]`, `index` y `bookmarks:true`; `add_bookmark` escribe una
  entrada de esquema; `extract_pages` escribe en `output` y `split_pages` un archivo
  numerado por página o cada `every` páginas sin tocar el documento de la sesión;
  `extract_attachment` hace viaje de ida y vuelta de archivos incrustados; `rotate_pages`
  se suma a la rotación actual; `delete_pages` conserva una página; `compress`
  informa `bytesBefore`/`bytesAfter`; `add_text` acepta `align:'center'|'right'`
  y numera un archivo existente mediante `{page}`/`{pages}`; `highlight` marca
  cada coincidencia de `find` (o un recuadro; `wholeWord`, `regex` y `first` la
  restringen) con una marca de fusión multiplicada que deja el texto legible; `add_link`
  coloca un enlace invisible sobre una coincidencia que abre una URL u otra página, o
  con `urls:true` hace que cada dirección http(s) del texto se abra sola;
  `stamp_image` se ajusta dentro de los márgenes salvo que se indique tamaño;
  `issues` ya no informa dos veces de una página escaneada y nombra el contenido activo
  (`active_content`: JavaScript, Launch, acciones al abrir, enlaces a archivos u
  otros esquemas no web) sin seguirlo. Análisis: `pdf-layout` con
  `query` devuelve solo las coincidencias con sus recuadros; sus cuadros de texto siguen
  la línea en páginas rotadas y para texto diagonal, y él y la instantánea informan de
  `origin` cuando el recuadro de una página no empieza en 0,0. Las marcas de `find` invierten la
  transformación de visualización para manejar tanto los desplazamientos de origen como las rotaciones
  de página de 90/180/270 grados sin reorientar el documento; `first:true` conserva el orden de
  filas del documento en cada rotación. El layout lista los
  enlaces de cada página (`url` o la `page` de destino) y añade las líneas de cada página (`lines`) y
  `boxes` (cuadrados pequeños marcados `checkbox`), que es lo que necesita rellenar un formulario
  sin campos; `pdf-tables` lee una tabla con bordes a partir de los
  rectángulos de sus celdas (`source:'ruled'`, celdas ajustadas intactas) antes de la
  suposición por alineación de texto (`source:'alignment'`) y escribe un CSV por tabla
  cuando se da `output:<dir>`, igual que `pdf-images` escribe archivos PNG e informa de
  dónde se sitúa cada imagen en la página; OCR ajusta
  cada palabra invisible a su recuadro para que la capa de texto conserve espacios sencillos. Las vistas
  previas de página (`render`, `qa`, `finalize`) dan a pdf.js sus fuentes estándar
  incluidas, de modo que una página en Helvetica o Times ya no se renderiza
  con letras espaciadas. El adaptador se divide en `pdf-writer`, `pdf-forms`,
  `pdf-draw` y `pdf-fonts`, y la habilidad se reescribe como inspect →
  create → edit → secure → verify con el requisito de qpdf (PATH o
  `MIXDOG_QPDF_PATH`), la salvedad de los bits de permisos y el límite del texto
  en el sitio declarados.

- La habilidad y el runtime de xlsx adoptan la disciplina de modelado que un lector espera
  de una hoja de cálculo: una auditoría de fórmulas neutra respecto al backend (compartida por `issues`
  portable y la revisión de calidad) informa de una referencia de hoja de varias palabras sin comillas,
  un vínculo a un libro externo, un porcentaje almacenado como número entero,
  un año con separador de miles y una cifra almacenada como texto
  en cualquier libro (además, como información, una hoja larga cuyo encabezado
  no está inmovilizado y una columna de tabla de números en General), y
  bajo `auditProfile:'financial-model'` una tasa en línea en una fórmula, una
  división sin protección, una fórmula aislada que rompe el patrón de su fila o columna,
  una referencia única más allá de la extensión poblada de la hoja (el error de uno que
  se recalcula sin quejas), un valor fijo dentro de una fila de fórmulas, y entradas
  indistinguibles de
  fórmulas, además de una entrada que lee una fórmula sin nota de origen y una
  comprobación de cuadre de la hoja Checks que evalúa FALSE, en ambos backends, ya que el
  `issues` de Excel ahora integra la auditoría compartida en los hallazgos propios del host. Las instantáneas
  exponen el formato numérico, la fuente, el color y el relleno de cada celda con estilo (los
  enteros BGR de Excel se normalizan a la misma forma RRGGBB), notas heredadas por celda y por
  hoja, tablas de Excel por hoja (los registros dentro de una son datos que la tabla
  origina, de modo que la auditoría pide una nota solo en las suposiciones fuera de ella),
  rangos combinados y paneles inmovilizados con la forma de Excel,
  booleanos como booleanos, el `defaultStyle` del libro y un
  resumen `document.conventions` (fuente predeterminada, fuentes en uso, formatos numéricos
  por columna, marcadores de entrada, entradas de muestra) para que una edición pueda ajustarse a las
  convenciones propias del archivo; `set_formula` pone comillas a los nombres de hoja de varias palabras que
  contiene el libro (y, en ambos backends, a cualquier nombre de varias palabras escrito
  antes de `!` y una referencia) e informa la `normalizedFormula`, el
  recálculo de LibreOffice devuelve un `status` con `totalErrors`, un `errorSummary` por
  tipo de error y celda, y las `unparsedFormulas` que LibreOffice reescribió en
  minúsculas, y `finalize` rechaza un libro cuyo recálculo encontró algún
  error incluso cuando se omitió la revisión. La habilidad reescribe sus reglas en torno a cero
  errores de fórmula, fórmulas en lugar de resultados pegados, especificaciones literales, suposiciones
  documentadas, la leyenda de relleno y ajustarse a las convenciones de un archivo existente,
  con `references/model-conventions.md` para colores, formatos numéricos,
  estructura, la hoja Checks y el origen de los datos.

- La habilidad pptx abre con una tabla de rutas —una presentación nueva es un script
  `author`, una presentación existente es `open` → `snapshot` → `batch`, y leer es un
  `snapshot` paginado o el extractor de código fuente— y resuelve las rutas de sus scripts
  mediante `${MIXDOG_SKILL_DIR}`, de modo que el QC de páginas, el revisor independiente y
  `source-extract.mjs` (movido a la habilidad con una prueba) se ejecutan desde cualquier
  Proyecto. La sección de edición nombra las trampas que el runtime realmente tiene:
  una diapositiva duplicada comparte su parte de gráfico con la original, la decoración
  de la plantilla se queda donde la dejó el recuento de líneas del marcador de posición, y un script
  que declara su propio `pres` hereda el lienzo de 10 × 5.625 in de pptxgenjs.
  Las habilidades docx, xlsx y pdf añaden los disparadores que los usuarios realmente escriben
  ("Word", "Excel", "PDF 읽어", "PDF 만들어"), y la habilidad docx dice cómo una
  instantánea muestra un salto de línea.

- La edición portable de PowerPoint resuelve el destino de relación de un gráfico como lo hace
  el paquete: pptxgenjs lo escribe como un nombre de parte absoluto
  (`/ppt/charts/chart1.xml`), que `set_chart_data` y las demás operaciones de gráfico
  sobre una presentación creada solían informar como parte ausente. Las instantáneas
  portables ahora conservan los saltos de línea y finales de párrafo como saltos de línea —el texto de formas
  y notas de una presentación, y el texto de párrafos, celdas, comentarios,
  revisiones, notas y controles de contenido de un documento de Word— en lugar de pegar "4주차" y
  "잔존율".

- Las barras de pestañas de los paneles animan las altas y los cierres con la temporización de las animaciones de la interfaz: una pestaña nueva crece
  desde la nada mientras sus vecinas se encogen, de modo que la serie nunca desborda la
  barra y retrocede, y una pestaña cerrada se colapsa en su sitio mientras las
  restantes se deslizan a su espacio en lugar de saltar. Un borrador promovido a su
  sesión sigue intercambiándose al instante, y la barra elimina su estado
  de retención de ancho sin usar.

- La creación en Office gana tres estructuras de calidad de salida: `author` y
  `batch` devuelven un `audit` medido (ajuste, límites, contraste, espaciado, paquete)
  con recuentos por diapositiva y un mandato de corrección en el mismo turno que cuenta sus rondas;
  `author` se niega a aceptar una presentación cuyas cifras no tengan ningún hecho detrás
  (`facts_gate`) salvo que el brief declare `facts: sample`, lo que lleva una
  divulgación de cifras ilustrativas a través de qa y finalize; y la habilidad pptx
  incluye `scripts/qc-pages.mjs`, un corrector por página que ejecuta una sesión nueva
  por diapositiva solo con la herramienta office y adopta su copia de trabajo únicamente cuando
  los defectos medidos de la página no crecieron y ninguna otra diapositiva cambió.

- Las habilidades dividen su línea de listado en una descripción de una frase y un
  disparador `when_to_use`; la lista de habilidades del modelo muestra `description — trigger`
  cortado a 250 caracteres, el editor de habilidades gana un campo Activador separado, el
  validador de skill-creator avisa cuando una línea de listado se va a cortar, y cada
  habilidad integrada se reescribe con la nueva forma.

- La isla de Objetivo de la sesión alinea su lista de tareas con el encabezado contraído,
  separa las filas con líneas finas y se contrae al pulsar fuera o con Escape.

- La superficie del teléfono sigue la interfaz de la aplicación de escritorio: el indicador de contexto se sitúa junto al
  disparador de modelo del compositor, las marcas de la barra de herramientas comparten la familia lucide,
  y la hoja derecha se abre como una unidad de dock cuyo encabezado lleva los mismos
  conmutadores de vista que la franja del escritorio.

- Las habilidades integradas se distribuyen desde una fuente de habilidades incluida, y las guías de Office
  pasan a ser habilidades pptx, docx, xlsx y pdf condicionadas a la función que manejan.
  Ajustes agrupa las habilidades, servidores MCP y hooks dependientes bajo su plugin
  o función integrada.

- Office crea presentaciones PPTX a partir de scripts de pptxgenjs con una guía de diseño,
  kit de helpers, menú de diseños y QA visual dirigido por el modelo, y tolera
  diferencias en el orden de los hijos de presentación y gráfico.

- Las llamadas a herramientas convierten los argumentos en texto JSON a la forma de su esquema declarado,
  incluidos los esquemas internos del registro.

- Browser Use divide la política de URL, pestañas, partición, ocultación de datos y script de instantánea
  en módulos dedicados; Computer Use refina el modelo del overlay,
  el backend de entrada y la coordinación de sesiones.

- El calentamiento de arranque del escritorio, la restauración del dock lateral, el momento de reinicio del uso, los archivos
  de descubrimiento propiedad del puente y la recuperación del transporte de sesión mantienen ágiles los arranques en frío
  y las reconexiones. Los despliegues FastDirect precalientan el runtime instalado.

- El ejecutor de pruebas separa los niveles rápido, lento y live con informes de tiempos;
  los almacenes de sesión cachean resúmenes de transcripción y barridos de listado; las utilidades de
  solicitud de proveedor refuerzan el manejo de protocolo de Anthropic, Cursor y OpenCode.

## v0.9.160 - 2026-09-02

- La TUI ahora instala su runtime Ink parcheado desde un recurso de versión con versionado.
  Las compilaciones de producción, los arneses de fotogramas y las sondas de carga resuelven el
  paquete instalado conservando el comportamiento personalizado de cursor, selección y renderizado.

- El arranque del escritorio ahora revela cascarones de panel utilizables antes de que termine la hidratación, más lenta, del
  catálogo y del runtime. Las superficies de Browser, Terminal, Editor y del dock lateral
  se restauran de forma independiente, con sondas de disponibilidad específicas y servicios del host
  diferidos que mantienen ágiles los arranques en frío.

- Browser Use y Computer Use ahora tienen módulos de host basados en roles en lugar de
  monolitos planos. Las acciones del navegador comparten enrutamiento explícito, ciclo de vida del guest y
  contratos de respuesta con un manejo más sólido de selectores de archivos y diálogos, mientras que
  Computer Use separa las responsabilidades de descubrimiento, observación, entrada, sesión, overlay y
  backend con una cobertura de seguridad ampliada.

- Los módulos de runtime de Office se organizan por roles de core, design, quality, portable,
  PDF, COM y benchmark. La composición libre, la selección de diseño guiada por referencias, las escenas de
  PowerPoint creadas y las comprobaciones de garantía renderizadas mejoran la
  calidad visual sin debilitar la salida editable ni los límites de las transacciones.

- Las sesiones de Anthropic OAuth ahora aprenden una versión mínima de CLI exigida por el proveedor,
  persisten solo actualizaciones seguras al alza y reintentan una vez la solicitud rechazada sin
  anular la configuración de versión explícita.

## v0.9.159 - 2026-09-01

- La aceptación de versiones de Windows ahora comprueba el inventario canónico de 16 elementos de ajustes
  en lugar del recuento obsoleto previo a la navegación.

- Computer Use ahora coordina los arrendamientos de destino en primer plano, recaptura tras
  transiciones de ventana, valida secuencias de acciones acotadas y expone un overlay de
  toma de control del usuario. Las rutas de captura, teclado, selección de destinos y recuperación se
  dividen en módulos específicos con mayor cobertura de host y puente.

- Browser Use gana registros con alcance de sesión y superficies persistentes por conversación.
  Las vistas de navegador, diff y utilidades pueden permanecer ancladas al dock lateral de cada
  conversación, mientras que las lecturas locales de archivos sustituyen la ruta duplicada
  retirada del explorador de carpetas.

- La compactación con contexto nuevo ahora lleva un traspaso de Memoria acotado, conserva la
  continuación del turno activo y el estado del sobre de herramientas, y mantiene estables los diseños de
  caché del proveedor a través de la compactación. La ingesta de Memoria proyecta la transcripción compactada
  de forma coherente en lugar de depender de la ruta rápida retirada.

- La generación de presentaciones de Office añade dirección creativa, gramática de diseño, flujo
  visual semántico, revisión estética renderizada y una puntuación de calidad de versión, de modo que
  la salida de las presentaciones es más variada y detecta antes las composiciones débiles.

- Baja bruscamente la rotación en la verificación y la infraestructura de versiones: el monolito de
  tool-smoke de 3,500 líneas ahora son catorce suites específicas de `node --test` bajo
  `scripts/tool-contracts/`, con aserciones frágiles de redacción exacta relajadas a
  contratos de frases clave, la selección de rutas de CI tiene una única fuente en
  `scripts/release-paths.mjs` tanto para la puerta de versión como para la planificación del despliegue,
  y una versión omite volver a ejecutar el carril crítico cuando la puerta ya
  verificó exactamente los mismos commits.

- Ya ninguna suite puede pudrirse en silencio: los monolitos de pruebas restantes
  (provider-toolcall, session-transport, shell-hardening) son suites por dominio
  bajo `scripts/`, la puerta de versión ahora ejecuta los contratos de tool-contract
  y de compactación (recall-fasttrack) en cada push controlado, y un
  barrido semanal `suite-health` ejecuta cada script `test:*`/`smoke:*` registrado
  mediante un catálogo de exclusión voluntaria que abre una incidencia con seguimiento al fallar.

## v0.9.158 - 2026-08-31

- El hub de Extensiones ahora ofrece a Git, Memoria, Browser Use, Computer Use, Office
  y voz un flujo coherente de instalación, progreso, activación y desactivación. Los runtimes
  opcionales se preparan bajo demanda, Office puede instalar LibreOffice mediante el
  gestor de paquetes de la plataforma, y desactivar la voz conserva los recursos descargados.
- El empaquetado del runtime de escritorio es más pequeño y determinista: las cargas de funciones
  opcionales quedan fuera de la aplicación base, el código del runtime se prepara una vez, los
  despliegues de instantáneas toleran ediciones concurrentes, y la CI de versiones comparte una única compilación
  de runtime multiplataforma con puertas explícitas de Git y Computer Use.
- Studio conserva los borradores por elemento y hace que la edición de detalles, la selección y
  las interacciones de teclado sean resistentes a la navegación. Los controles de uso de contexto y
  dictado por voz también informan de su estado actual de forma más coherente.
- La ruta de OpenAI OAuth deja desactivado por defecto el precalentamiento de prompts por WebSocket,
  evitando una solicitud de calentamiento innecesaria salvo que se active explícitamente.
- Terminal-Bench 2.1 publica la comparación completa `k=5` de Codex CLI con artefactos Harbor
  sin procesar, verificación de commits de origen, procedencia de costes recuperados y
  generación de informes reproducible.

## v0.9.157 - 2026-08-31

- Browser Use gana una división de host más pequeña y fiable entre pestañas, descargas,
  interceptación, permisos, instantáneas, informes de diálogos y ciclo de vida de páginas.
  La importación de perfiles de Chromium ahora incluye el descifrado sin conexión de cookies App-Bound v20
  mediante el importador nativo empaquetado, sin exponer secretos descifrados al
  renderer ni al agente.
- Computer Use se descompone en módulos acotados de captura, descubrimiento, selección de destinos,
  observación, entrada y worker. Una propiedad de recursos más justa, un estado posterior
  a la acción más reciente, protecciones de entrada más estrictas y escenarios de repetición ampliados hacen que
  las sesiones nativas y de Chromium de larga duración sean más rápidas y seguras.
- Memoria pasa a un runtime de embeddings E5 compacto con relleno incremental
  empezando por lo más reciente, compresión y retención de caché, clasificación léxica atenta al coreano y
  recuperación de workers inactivos. El antiguo addon nativo de tokens y la ruta
  heredada de modelo más pesado se eliminan del runtime distribuido.
- La recuperación de sesiones promueve el diario de puntos de control al límite de reanudación
  duradero, conservando el uso del proveedor, los anclajes de compactación, el traspaso de recall y
  la reproducción del thinking de Anthropic ante interrupciones, reintentos y reinicios sin
  duplicar contexto.
- La creación en Office añade planes de composición redactados por el modelo, una biblioteca de
  diseño reutilizable, vista previa de documentos y primitivas portables más amplias de Word, Excel y PowerPoint
  conservando las comprobaciones de garantía estructurales y renderizadas.
- Las superficies web de escritorio y móvil ganan Browser Use remoto, recepción de share-target,
  notificaciones push, edición y vista previa de documentos más ricas, restauración de arranque más
  silenciosa y actualizaciones de caché del service worker más predecibles.
- La búsqueda nativa ahora acota los arrendamientos de inventario amplio y admite de forma justa trabajo
  concurrente de find, glob y grep. La automatización de versiones reconstruye de forma incremental los recursos nativos
  y de voz modificados, verifica los sidecars empaquetados y reutiliza los artefactos de runtime
  de plataforma sin cambios.

## v0.9.156 - 2026-08-29

- La creación portable de Office gana renderizado de gráficos y métricas de texto, de modo que más
  trabajo de PPTX y XLSX se completa sin traspasarlo al host COM de Office.
- Los contratos de las herramientas Browser Use y Computer Use se revisan junto con el
  almacén de ajustes del escritorio, la validación IPC y el formato de herramientas de la transcripción.
- El desplazamiento virtual del escritorio ahora sigue los paquetes upstream, y el anclaje inferior
  de la transcripción se apoya en el propio aplazamiento de desplazamiento del núcleo.
- Los despliegues de desarrollo pueden ejecutarse desde una instantánea congelada del árbol de trabajo
  (`update:dev:snapshot`), lo que permite que una instalación tenga éxito mientras otras sesiones
  siguen editando el repositorio en lugar de fallar la comprobación de huella de entrada.

## v0.9.155 - 2026-08-29

- La importación de diapositivas PPTX, el reemplazo de imágenes y la creación de datos de tablas ahora se ejecutan en el
  motor portable, de modo que esas operaciones ya no requieren el host COM de Office.
- La creación en Office gana módulos portables de empaquetado, composición, estilo de hoja y
  formas de diapositiva tras el flujo existente de garantía y calidad.
- El seguimiento de Objetivo gana el manejo de recordatorios y extracción de texto para continuaciones,
  y el escritorio mantiene sincronizados los metadatos de sesión con un presupuesto de caché del renderer
  acotado para el estado de sesiones sin leer.

## v0.9.154 - 2026-08-29

- Las sesiones de Computer Use se recuperan en cada ruta de salida en lugar de depender de
  un temporizador sin referencia que un runtime que se marcha nunca dispara: el cierre del daemon y de los workers
  las libera, una sesión que se cierra libera la suya, los workers de host inactivos caducan
  con el mismo reloj que los claims de ventana que mantienen, y una conexión de cliente caída
  aborta la entrada en curso en lugar de dejar que maneje el escritorio hasta que
  expire el tiempo de espera del comando. El cliente también reintenta una vez contra un puente republicado, de modo que
  reiniciar la aplicación de escritorio ya no hace fallar de plano el siguiente comando.
- Una página de Browser Use bloqueada se recupera con el siguiente comando en lugar de hacerlo fallar.
  Las refs ligadas al documento muerto se descartan con él, de modo que la recuperación nunca puede
  devolver coordenadas de una página que ya no existe.
- La compactación que se ejecuta entre un prompt y la solicitud al proveedor ya no se cuelga
  cuando el runtime de memoria se detiene: la llamada de memoria recall-fasttrack está acotada para
  todos los llamantes, no solo para la ruta que casualmente tenía cableado un tiempo de espera.
- El analizador de entradas ocultas del Explorador de Windows divide la salida de attrib.exe con las reglas
  de ruta de Windows en cualquier host, y la sonda de capacidades del hook de commit ahora funciona con
  versiones de git que discrepan sobre si un nombre de hook no nativo necesita una opción.
- Deploy deja de reconstruir runtimes de plataforma idénticos byte a byte. Los fuentes de pruebas salen tanto
  del paquete publicado como de la clave de caché del runtime, de modo que un cambio solo de pruebas
  acierta en la caché del runtime preparado en lugar de pagar una reconstrucción de siete minutos en Windows.
  Las suites de escritorio se ejecutan como trabajos paralelos de la puerta, incluido un tramo de Windows que
  por fin ejercita Computer Use en la CI, y la suite de git de 240 segundos ya no
  forma parte de la ejecución local por defecto.

## v0.9.153 - 2026-08-28

- Computer Use en Windows ahora ejecuta un bucle de observación más pequeño al estilo CUA: se devuelven juntos por defecto
  una accesibilidad compacta y una captura de pantalla simple,
  el estado posterior a la acción se actualiza de inmediato, AX y el OCR alternativo comparten un único
  presupuesto estricto de elementos, las capturas inservibles en negro, blanco o discordantes nunca
  emiten un marco de coordenadas, las mutaciones invalidan los marcos de píxeles previos, un nuevo
  popup del mismo proceso se convierte en el destino determinista de verificación, los campos de texto de
  Electron propios de la aplicación usan inserción en segundo plano nativa del renderer, la recuperación nombra
  un siguiente peldaño de escalada, y las teclas peligrosas que terminan la sesión, las cargas de shell
  o los lanzamientos de shell/script-host se bloquean en el límite del host. Un panel de Windows de 23 escenarios ahora cubre
  las rutas nativas, Electron, Chrome, OCR coreano, pantalla secundaria, estado obsoleto, foco,
  popup, seguridad y limpieza.
- Las observaciones y los turnos de Computer Use son más rápidos sin debilitar el límite de
  entrada: instantáneas ligeras de transición/fotograma de Win32, captura exacta de ventana,
  accesibilidad acotada de Chromium moderno, sondeo adaptativo de lanzamiento, protecciones de recursos de captura
  y recuperación verificada de foco/cursor sustituyen a la enumeración completa repetida de aplicaciones
  y a las alternativas sin límite. La escritura literal dirigida a un elemento puede
  enfocar y escribir en una sola acción, y un OCR acotado puede incluirse en la captura
  obligatoria posterior a la acción. La matriz final de 23 escenarios × 10 de host de origen alcanzó
  230/230 aciertos semánticos y redujo la latencia p50/p95 de escenario de referencia en
  90.55 %/94.01 %; una matriz de estrés aparte de destinos densos/minimizados/obsoletos pasó
  40/40. Se eliminaron las 30 recapturas posteriores a la acción redundantes, y las llamadas bajaron
  un 36.84 % en los cinco flujos de acciones agrupables. El batching arbitrario de mutaciones
  sigue sin admitirse.
- Computer Use ahora expone un único contrato estricto de 15 acciones en lugar de 28
  acciones solapadas o un esquema plano de campos opcionales. Observación/búsqueda/zoom
  usan `capture`, el ciclo de vida de ventanas y portapapeles usa campos de operación, y un
  único objeto compartido `capture_after` configura la verificación automática. La guía
  alineada con la referencia exige destinos exactos recientes, prefiere elementos semánticos
  y mantiene Browser Use separado. El esquema final era de 2,644 tokens estimados
  antes de las extensiones de frontera; el contrato de frontera previo a la eliminación pasó
  36/36 escenarios de primera llamada del modelo. El contrato actual de despacho directo es
  de 3,210 tokens estimados y 14,485 bytes en el cable. `diagnose`, de solo lectura,
  informa de la disponibilidad de OCR/UIA de Windows sin píxeles de pantalla; `sequence` acotada
  se detiene ante un fallo o una transición de destino y devuelve un estado final nuevo;
  la cardinalidad estricta de llamadas impide mutaciones paralelas entre destinos, tanto
  en la guía del modelo como antes del despacho anticipado del runtime. Las llamadas
  `computer` adicionales del mismo turno no se ejecutan y reciben un error de recuperación con estado nuevo.
  La selección en lenguaje natural pasó 4/4 cadenas de foco seguras y 4/4 límites de transición.
  En 10 repeticiones, una continuación de dos acciones usó un 50 % menos de
  llamadas y capturas orientadas al modelo, con la latencia p50/p95 reducida 12.34 %/32.31 %.
  Se eliminaron los avisos de confirmación de Computer Use y de aprobación de transacciones de Office
  orientados al modelo; las acciones solicitadas por el usuario ahora se ejecutan directamente mientras
  los patrones de teclas, cargas y script-host bloqueados siguen siendo errores firmes.
  El uso medido del proveedor es de 5,150 tokens de entrada y 4,026 ms p50 por llamada
  al modelo. Un esquema posterior a la observación de 12 acciones redujo la entrada un 18.16 % con
  27/27 de precisión pero se rechazó porque los valores atípicos de latencia repetidos y los cambios de
  esquema a mitad de bucle romperían el contrato inmutable de caché de prefijo del proveedor.
  Las acciones semánticas con transiciones deterministas de ventana exacta ahora informan de
  verificación confirmada. No queda ninguna alternativa con la forma de llamada heredada. Tras un
  despliegue de desarrollo, la validación de la aplicación instalada confirmó que el
  `click(ref)` izquierdo usa activación semántica y que un lanzamiento por asociación nativa de archivos
  devuelve su destino seleccionado con estado nuevo; las marcas y coordenadas
  siguen siendo operaciones de puntero explícitas.
- Browser Use puede importar contraseñas, cookies e historial de Chromium, sugerir solo cuentas
  enmascaradas para el origen HTTPS actual y rellenar un formulario de inicio de sesión seleccionado
  dentro de un mundo CDP aislado sin exponer la contraseña almacenada al
  renderer, al agente, a los diagnósticos ni a los registros. Utilidades ahora usa por defecto la primera
  pestaña del lado derecho, migra la ubicación predeterminada antigua sin restablecer los diseños
  personalizados, e incluye el punto de entrada de Browser.
- FastDirect ahora toma huellas, prepara, respalda y restaura atómicamente los sidecars
  nativos del importador de navegador junto con `runtime.asar`, de modo que las actualizaciones
  incrementales de desarrollo no pueden dejar la aplicación instalada sin su importador.
- El uso de contexto de la sesión ahora registra una instantánea canónica posterior a la compactación que
  sobrevive a la persistencia y al reinicio hasta que el siguiente turno la invalida. El estado
  de Objetivo y la recuperación de compactación se mantienen coherentes entre servicios reiniciados
  en lugar de repintar un uso de tokens obsoleto o perder trabajo reanudable.
- La generación de Office ahora comparte un modelo de contenido semántico, comprobaciones de garantía
  estructurales y renderizadas, revisión de inyección de prompts, puertas de lista de verificación y un
  flujo de pulido en Word, Excel y PowerPoint. Los controles de página/vista de hojas de cálculo, la selección
  de capacidad de plantilla, la persistencia de datos de gráficos nativos y la verificación
  en vivo de guardar y reabrir refuerzan los documentos de calidad de versión.

## v0.9.152 - 2026-08-27

- El modo Objetivo ahora puede llevar un objetivo de larga duración a lo largo de varios turnos con condiciones
  de finalización duraderas, controles de pausa y reanudación, límites de tiempo, continuación
  automática, herramientas de gestión orientadas al modelo y una isla de
  estado de escritorio con alcance de sesión.
- Browser Use y Computer Use de Windows están disponibles como capacidades integradas
  opcionales. Browser Use puede inspeccionar y operar páginas dentro de la aplicación o en segundo plano,
  mientras que Computer Use combina UI Automation, capturas de pantalla, acciones de teclado, puntero,
  desplazamiento y ventana con entrada consciente del DPI y protecciones de seguridad.
- La recuperación del proveedor ahora conserva el orden original de razonamiento, texto y
  llamadas a herramientas en los streams de Anthropic, Gemini, OpenAI y compatibles, incluidos
  reintentos, turnos detenidos, sesiones guardadas, proyección remota y compactación.
- La compactación inicia una época nueva de caché de lectura tras cambiar la transcripción,
  y las sesiones existentes sincronizan las herramientas de runtime recién disponibles en los límites
  de turno en lugar de mantener un catálogo de herramientas obsoleto.
- La navegación de escritorio y móvil es más limpia y predecible: los reinicios
  móviles empiezan con una sola New task mientras las reconexiones conservan los paneles actuales,
  los gestos de deslizamiento entre paneles funcionan sobre contenido enriquecido y superposiciones, y las páginas laterales, extensiones,
  Markdown, etiquetas de estado y acciones finales comparten diseños
  adaptables más compactos.

## v0.9.151 - 2026-08-26

- Editar un enlace simbólico ahora cambia el archivo al que apunta en lugar de
  rechazarse: patch y edit siguen el enlace en todos los motores, escriben
  de forma atómica junto al destino real y dejan intacto el propio enlace.
- Las ejecuciones headless y de benchmark ya no dejan bases de datos temporales ni procesos
  atrás. Cada ejecución obtiene una raíz de runtime aislada, el cierre espera al daemon
  de sesión en lugar de informar de éxito antes que él, y los clústeres huérfanos se
  barren al salir.
- La compactación de conversaciones conserva todo lo que debe. La compactación automática, manual y
  borrada comparten una sola ruta, el resumen almacenado encabeza con el historial completo sin procesar
  detrás, y los turnos más recientes sobreviven literalmente en lugar de ser
  recortados por un límite de filas o de tamaño.
- La exploración lee el archivo original antes de decidir cómo analizarlo, contarlo o
  resumirlo, de modo que una suposición sobre el formato ya no determina la respuesta.
- Pulido del escritorio: las imágenes adjuntas se abren en el visor del sistema, las filas de cuota
  del panel de uso se leen en un orden natural, y los paneles de contexto y ruta pierden
  sus marcos y contornos de foco sobrantes.
- Los resultados de Terminal-Bench 2.1 se republican a partir de una ejecución `k=5` de las 89 tareas,
  con los artefactos de verificación sin procesar de cada ejecución publicada incluidos en el repositorio
  junto con el arnés y los scripts de métricas.

## v0.9.150 - 2026-08-25

- Los resultados de herramientas siguen siendo fáciles de recorrer y honestos sobre su tamaño: la salida de búsqueda y
  las lecturas de varios archivos se atienen a un presupuesto fijo en lugar de inundar una respuesta con
  miles de líneas, y una ruta que simplemente no existe —o un veredicto
  ordinario de estado del repositorio— vuelve como la respuesta en lugar de como un fallo
  que envía al asistente a la recuperación.
- Las sesiones ya no arrastran una huella de proveedor obsoleta tras un reinicio, y un
  mensaje nuevo despierta de inmediato un turno que espera una tarea en segundo plano, de modo que
  una respuesta llega en lugar de quedarse detrás de la espera.
- La selección de texto del terminal se recupera de un arrastre cuyo botón se soltó
  fuera de la ventana, y una selección arrastrada más allá del borde superior o inferior
  sigue el comportamiento normal de inicio y fin de línea en lugar de congelarse en la
  última columna que mantenía el puntero.
- El dictado por voz pide confirmación antes de instalar su runtime, las tarjetas de
  herramientas y los marcos de diff se alinean con el tema compartido, y se actualizan diez idiomas
  de la interfaz.

## v0.9.149 - 2026-08-24

- Las sesiones de OpenAI OAuth ahora hablan por defecto la forma de protocolo del cliente de referencia:
  identidad estable de instalación e hilo, la forma de solicitud más ligera en los modelos
  actuales y un manejo correcto para el proveedor de un socket que alcanza su límite de vida
  a mitad de sesión.
- El inicio de sesión reserva su conexión precalentada para el primer turno solo
  cuando el prompt que calentó sigue coincidiendo, de modo que un turno cuyo entorno o superficie de
  herramientas cambió empieza limpio en lugar de reenviar toda la solicitud.
- Los listados de directorios devuelven una primera página dimensionada para recorrerla en lugar de un volcado,
  y las consultas de estructura de código obtienen cuerpos completos de símbolos solo cuando se necesita
  la implementación exacta.

## v0.9.148 - 2026-08-24

- Las conversaciones de escritorio y móvil conservan con más fiabilidad borradores, historial, comportamiento de seguimiento,
  gestos de panel y estado remoto, a la vez que reducen la transferencia del relé y la sobrecarga
  de despliegue del renderer.
- Las sesiones de agentes recuperan con más coherencia streams de proveedor, compactación, estado de workers y resultados
  de herramientas, con resultados de conflictos de Git y de entorno más claros y una telemetría
  de búsqueda más precisa.
- La entrada de voz gana una ruta de publicación de runtime multiplataforma verificada, mientras
  que la recuperación de memoria, el manejo de procesos nativos y la preparación del runtime
  empaquetado se refuerzan.
- La automatización de versiones, el despliegue FastDirect y los informes de benchmark ahora reutilizan
  artefactos sin cambios y comparan llamadas al modelo, coste y contexto final con
  una contabilidad correcta por proveedor.

## v0.9.147 - 2026-08-21

- Las sesiones largas de OpenAI ahora mantienen intactos su cadena de respuestas y el anclaje de estado de turno
  a través de reconexiones, reordenación de elementos y compactación, de modo que la caché de prefijo del
  proveedor sobrevive a una sesión en lugar de reiniciarse a mitad de tarea.
- El inicio de sesión precalienta el prefijo del proveedor y separa los detalles del entorno
  del prefijo de instrucciones compartido, reduciendo los arranques en frío y la subida repetida
  de contexto idéntico.
- Las reglas de uso de herramientas se leen más cortas con las mismas garantías: las cláusulas de enrutamiento ahora
  desaparecen con las herramientas que nombran, y los resultados de shell se clasifican por el
  ejecutor que los produjo.
- Las tarjetas de herramientas del escritorio y los resúmenes de resultados están localizados, y el indicador de contexto
  informa de la estimación posterior a la compactación en lugar del prefijo descartado.
- Las ejecuciones de benchmark ganan preajustes de ruta rápida y un adaptador de referencia de grok CLI, de modo que
  los números de referencia proceden de los mismos contenedores y verificador.

## v0.9.146 - 2026-08-21

- Las conversaciones web móviles ahora mantienen estables el desplazamiento táctil, la medición de
  Markdown en streaming, los deslizamientos de pestañas, los controles compactos del compositor y las superposiciones adaptables
  ante gestos nativos, rotación y diseños de pantalla pequeña.
- Las sesiones pueden llevar una conversación completa al modelo seleccionado en ese momento
  cuando cabe en el límite de contexto de ese modelo, mientras que el uso de contexto y los detalles de
  ruta heredados siguen siendo explícitos.
- Los grupos de herramientas de la transcripción conservan sus llamadas, argumentos, salidas y
  estado de finalización originales para una inspección detallada, con vistas previas de imágenes localizadas y
  una presentación de la actividad más clara.

## v0.9.145 - 2026-08-21

- Las sesiones web móviles ahora mantienen estables la escala nativa del viewport, la recuperación del emparejamiento,
  la proyección del estado remoto y el desplazamiento de la transcripción ante gestos táctiles,
  mediciones de filas en streaming, restauraciones de la aplicación y conexiones lentas.
- Los paneles de escritorio, las actualizaciones de control de código fuente, la actividad de herramientas, las superficies de comandos y
  el estado de sesión se recuperan con más coherencia conservando los diseños adaptables
  y una información de carga o interrupción más clara.
- El enrutamiento de herramientas del agente ahora aplica protecciones de argumentos más estrictas, política de mutación de Git,
  manejo de prefijos de proveedor, proyección de evidencia y recuperación de salida de shell
  en el runtime compartido y la TUI.
- Las herramientas de versiones, benchmark, localización y diagnóstico ahora validan sus
  contratos con una cobertura de regresión más amplia e informes de runtime más compactos.

## v0.9.144 - 2026-08-21

- La interacción de escritorio ahora sigue con más fiabilidad el foco del teclado y del puntero,
  mejora los deslizamientos de panel móviles y la presentación de transcripción/estado, e informa del
  estado de las tareas de shell en segundo plano con una recuperación más segura.
- Los paneles de diff de Git muestran de inmediato su propio estado de carga, fusionan
  actualizaciones superpuestas y renderizan el texto del repositorio sin invocar los comandos
  externos de diff o textconv configurados.
- Solo es ahora el workflow predeterminado, las reglas de uso de herramientas conservan la evidencia mientras
  agrupan el trabajo con más rigor, y las ventanas acotadas de read/grep reducen el contexto innecesario
  sin ocultar la paginación.

## v0.9.143 - 2026-08-20

- La ejecución de sesiones ahora comparte un único worker de runtime supervisado en lugar de un pool de
  fragmentos de proceso. Los agentes en segundo plano permanecen en el proceso, las esperas del proveedor ceden
  su ranura local de admisión de CPU, y los límites de arranque de toda la máquina y la
  recuperación de salud del runtime siguen aplicándose.
- Las aprobaciones de dispositivos remotos aparecen solo mientras Ajustes → Conexión está abierto,
  recuperan las solicitudes pendientes cuando ese panel se abre, y terminan solo después de que el
  navegador demuestra su conexión E2EE autenticada.

## v0.9.142 - 2026-08-20

- El empaquetado de escritorio para Linux valida la arquitectura de destino en el directorio de
  prebuild de ABI que `node-pty` realmente carga, mientras que los paquetes compilados de Windows y
  macOS mantienen su ruta de validación `build/Release`.

- Las aplicaciones web instaladas reanudan una aprobación de escritorio pendiente a través de recargas, mientras que
  el escritorio reemplaza los avisos obsoletos, los caduca con la solicitud del relé y
  acepta cada decisión solo después de que el servicio la confirma.
- FastDirect reutiliza destinos de compilación recientes, una caché persistente de renderer de producción,
  salida de runtime preparada y una plantilla de shell ASAR extraída. Los despliegues
  en vivo del relé toman huellas de forma independiente de los cambios de renderer/servidor y suben
  solo deltas de renderer verificados antes del intercambio atómico en el VPS.
- El código en línea sigue la fuente y el tamaño de la prosa circundante, dejando el color como
  su única distinción en línea, mientras que el código en bloques sigue siendo monoespaciado.

## v0.9.141 - 2026-08-20

- La creación de tareas de escritorio funciona con Electron 41 y Node 24: el enrutador
  de fragmentos de agente ahora copia las exportaciones ESM inmutables del gestor de sesiones a una
  fachada escribible antes de instalar sus anulaciones de sesión remota.

## v0.9.140 - 2026-08-20

- Los borrados de Studio surten efecto con el primer clic: una ejecución terminada libera su
  hueco de la cuadrícula en cuanto se indexa su recurso, de modo que borrar ese recurso ya no
  resucita el hueco como un mosaico fantasma "generating". La galería ya no está
  limitada a 2,000 entradas —un recurso sale del almacén solo mediante un borrado
  explícito— y una ejecución que falla, empieza sin un trabajo o pierde su instantánea
  de runtime ahora lo informa en lugar de girar en silencio.
- El selector de pestañas móvil se lee como una cuadrícula de tarjetas y gana un campo de filtro solo
  cuando la lista es lo bastante larga como para necesitarlo, mientras que el cromo del teléfono replantea
  los discos del compositor, la isla de estado y las hojas de paneles con proporciones táctiles
  y acerca al alcance los controles que solo aparecían al pasar el cursor.
- Una aplicación web instalada puede emparejarse sola: abre una URL de entrada enrutada por dispositivo,
  pide aprobación a ese escritorio mediante un código de dos dígitos mostrado en ambas
  pantallas, y recibe el material de emparejamiento sellado con su propia clave desechable.
  Los navegadores emparejados ahora registran qué carriles push leen, de modo que un teléfono
  conectado ya no paga por el tráfico de terminal, editor y archivos que nunca muestra.
- El servidor de búsqueda de code-graph atiende a clientes de tubería compartida con colas de
  respuesta por conexión e ids de solicitud con alcance de cliente, y sale por sí solo tras una
  ventana de inactividad para que un propietario terminado a la fuerza deje de dejar servidores calientes atrás.
- Las llamadas a herramientas sobreviven al ruido de argumentos del proveedor: una ruta base opcional omitida
  se resuelve en el Proyecto actual en lugar de hacer fallar la llamada, los argumentos de las tareas
  se acotan a la acción elegida, y la salida de git conserva su último fotograma de progreso
  y su línea fatal final en lugar de enterrar el motivo bajo fotogramas
  de redibujado.
- El renderer carga un catálogo de idioma de la interfaz en lugar de once, fija el
  idioma antes de que se evalúe el primer módulo de la aplicación y precarga un fragmento
  de superficie al seleccionar; /inherit lleva una conversación existente a una nueva
  sesión en la ruta seleccionada actualmente.
- El crédito de terceros lo llevan solo LICENSES y NOTICE.

## v0.9.139 - 2026-08-20

- Antigravity OAuth llega como proveedor: un único inicio de sesión de Google expone Gemini 3.x
  y Claude a través de la pasarela Cloud Code Assist, con inicio de sesión, renovación de tokens
  y conmutación de endpoints siguiendo la forma de proveedor OAuth existente.
- Los agentes ahora tienen exactamente dos estados, un modelo fijado o desactivado, y Web Search
  resuelve el Modelo principal cuando su ruta se deja sin establecer.
- Los navegadores emparejados llegan a la superficie de operación del escritorio —instrucciones del proyecto,
  exploración de carpetas y ubicaciones, y el contrato de git— mediante un módulo compartido
  de validación de argumentos, mientras que el estado de sesión del relé viaja como deltas compactos
  con alcance de cliente dentro de tramas E2EE binarias.
- La aplicación web ahora distribuye recursos brotli y gzip precomprimidos, retiene los
  calentamientos y fuentes en segundo plano en conexiones con límite de datos o lentas, redimensiona los adjuntos
  de imagen y el audio de dictado antes de subirlos, elimina el desenfoque en vivo de la isla
  de estado fijada en teléfonos, y pinta el acento de marca en azul Google.
- La preparación del runtime de Windows y el empaquetado de asar sobreviven a los scripts de ciclo de vida del repositorio y
  a bloqueos transitorios de archivos del antivirus, y la línea de estado de la TUI calcula su
  recuento de shells en ejecución directamente en la ruta instantánea.

## v0.9.138 - 2026-08-19

- Las sesiones web remotas ahora usan suscripciones con alcance de cliente, tramas E2EE binarias,
  deltas compactos de estado/catálogo, agrupación de terminal y sondas de latencia de pintado,
  reduciendo el volumen de transferencia y conservando la recuperación en vivo en conexiones lentas.
- El desplazamiento de la transcripción web y la entrada del compositor permanecen visualmente estables durante
  instantáneas remotas concurrentes, cambios de sesión y renderizado móvil.
- El contexto de runtime, la recuperación de solicitudes al proveedor, las notificaciones de tareas en segundo plano
  y la restauración de finalizaciones se refuerzan en sesiones de larga duración.

## v0.9.137 - 2026-08-19

- La recuperación de reconexión remota ahora actualiza los catálogos de sesión y los carriles de
  transcripción montados, y el control de actualización encabeza el grupo de botones de la barra de título.

## v0.9.136 - 2026-08-19

- Se elimina la infraestructura retirada de mensajería Discord/Telegram y de sesiones de canal,
  mientras las barras del sistema móvil permanecen consistentemente negras.

## v0.9.135 - 2026-08-18

- El escritorio ahora conserva los diseños de paneles, el estado de la barra lateral, la geometría de los paneles y los
  borradores del compositor a través de recargas y reinicios de FastDirect, con una cobertura de
  regresión del renderer ampliada.
- La ejecución de shell ahora refuerza el borrado del entorno, la espera en caliente, la recuperación de finalización
  en segundo plano, el manejo de procesos nativos y el enrutamiento de herramientas en
  sesiones interactivas y headless.
- Las versiones de Linux de native spawn se enlazan estáticamente, la búsqueda en grafo y los informes
  de recall se refuerzan, y el enrutamiento de Terminal Bench y las herramientas de informes se
  actualizan.

## v0.9.134 - 2026-08-17

- El escritorio ahora incluye la marca de identidad seleccionada, un editor unificado de rutas de modelo con
  parámetros de modelo y orden de lista persistido, y desempaqueta node-pty junto al
  daemon empaquetado.
- La compactación de sesiones queda fijada por propietario: las sesiones de agentes siguen siendo semánticas,
  las sesiones de usuario usan recall-fasttrack. Ajustes ya no lista Core memories
  (viven en el proyecto), y el inventario de aceptación de Windows coincide.

- Las integraciones de proveedores y herramientas ahora incluyen el ciclo de vida de OAuth y la recuperación de tokens
  en Anthropic, Cursor, Grok y OpenAI, normalización de esquemas de herramientas específica de Grok
  y una expansión descompuesta de rutas/patrones de search y grep.
- La orquestación de sesiones y los flujos de la TUI ahora aplican el alcance por sesión propietaria,
  conservan las tarjetas de traspaso completado y de finalización en segundo plano a través de restauraciones,
  retienen los prompts en cola externalizados y clasifican los resultados entre fallos de comandos,
  errores de herramientas y fallos benignos.
- La navegación del espacio de trabajo de escritorio ahora conserva los títulos de sesión de los paneles durante las interacciones
  de arrastre, añade reintentos de restauración del espacio de trabajo en arranque en frío que evitan
  pestañas perdidas, y actualiza los paneles de incorporación y de configuración de capacidades.

## v0.9.133 - 2026-08-16

- La proyección de evidencia solo del proveedor ahora asigna alias a las rutas de archivo tipadas repetidas
  dentro de épocas de mutación, conservando los sobres exactos de herramientas y las rutas reconstruibles
  a la vez que reduce el contexto acumulado en sesiones largas.
- La ejecución de Git ahora comparte una política de mutación entre la orquestación y la
  proyección de evidencia, serializa las escrituras de todo el repositorio frente a las ediciones de archivos,
  usa procesos nativos propiedad del árbol y hace abortables los bloqueos en cola.

## v0.9.132 - 2026-08-16

- La ejecución de herramientas ahora expone el estado de salida completo de shell, añade una superficie
  dedicada de Git, refuerza la creación atómica de parches y los diagnósticos, y mejora
  la integridad de search, list, code-graph y del grafo nativo bajo carga concurrente.
- La compactación de sesiones, la recuperación de proveedor/imagen, el seguimiento de evidencia, la salud de fragmentos
  y la limpieza del runtime de Lead ahora conservan el estado ante fallos sin enmascarar
  workers degradados ni disparar trabajo de alternativa innecesario.
- El enrutamiento de escritorio, la actividad de agentes, el estado de paneles restaurado y el renderizado de
  Markdown en streaming ahora siguen siendo ágiles y visualmente coherentes en
  conversaciones en vivo y reanudadas.

## v0.9.131 - 2026-08-14

- Las puertas de versión ahora se ejecutan automáticamente con selección incremental de rutas, los runtimes
  de plataforma de escritorio se preparan antes del empaquetado, las compilaciones del grafo nativo usan un
  perfil reproducible más rápido, y el despliegue web/relé de producción incluye
  reversión atómica y verificación de hash y estado.
- Los carriles de versión de escritorio ahora empaquetan en cuanto su runtime correspondiente está listo,
  las cachés del compilador del grafo permanecen aisladas entre compilaciones de reproducibilidad, las instalaciones
  del relé se fijan por lockfile, y el tiempo de la versión avisa ante regresiones del 10 %.
- La limpieza de agentes ya no confunde las proyecciones del pool de Lead con workers hijos, de modo que
  desechar otro runtime no puede cerrar la conversación de escritorio activa ni
  descartar un mensaje de seguimiento aceptado.

## v0.9.130 - 2026-08-14

- La recuperación del proveedor y de la sesión ahora clasifica los fallos transitorios de stream
  de forma coherente, reintenta los turnos con imagen rechazada sin perder la intención del usuario y
  conserva el estado de interrupción, resumen y resultado terminal en los transportes de Gemini
  y OpenAI.
- Los fallos de herramientas se persisten sin contaminación de trazas de pruebas, la política de shell evita
  falsos positivos de scripts entrecomillados, y las rutas nativas de search/read/list/stat comparten trabajo
  cancelable conservando la invalidación fresca del observador y el comportamiento exacto de
  grep/glob por archivo bajo carga.
- Studio de escritorio, el uso, la actividad de agentes, el diseño de paneles, la localización y la presentación de las
  etiquetas de workers ahora se mantienen alineados entre sesiones restauradas y en vivo.

## v0.9.129 - 2026-08-14

- Headless exec ahora ejecuta por defecto una superficie solo de verdad: las herramientas de búsqueda web y
  memoria permanecen desactivadas salvo que --web-search / --memory las reactiven, los
  procesos hijos de shell heredan un proxy forzado sin salida (el loopback sigue
  accesible), y la línea de entorno de la sesión indica network=offline para que los
  modelos nunca intenten acceder a la web.

## v0.9.128 - 2026-08-14

- Las herramientas de exploración ahora terminan en la ronda de búsqueda: grep gasta su presupuesto
  de salida en bloques de código ordenados (primero las coincidencias de ramas raras), find descarta
  resultados difusos que son solo ruido, y los esquemas de símbolos de code_graph filtran antes de
  limitar y respetan las solicitudes de cuerpo.
- La guía de agentes agrupa una llamada mejor enrutada por incógnita en lugar de una
  expansión especulativa de varias herramientas, reduciendo el uso de tokens de benchmark en un tercio sin
  cambio en la tasa de aciertos.
- Refuerzo de la recuperación de sesiones y la resiliencia del runtime en la búsqueda nativa,
  el contrato de shell y las herramientas read/list.

## v0.9.127 - 2026-08-14

- Los binarios nativos ahora tienen un único hogar canónico en GitHub Releases: npm distribuye
  solo la CLI, mientras que las ejecuciones de la CLI verifican y cachean recursos bajo demanda y las
  compilaciones de escritorio incorporan los mismos recursos de plataforma verificados.

## v0.9.126 - 2026-08-14

- La búsqueda nativa ahora maneja el contrato interno completo de grep/find, conserva
  los errores de recuperación de regex y solapa el calentamiento de búsqueda y code-graph del primer turno.

## v0.9.125 - 2026-08-13

- La ejecución de shell y de tareas en segundo plano ahora usa un único gestor de procesos nativo con hash fijado
  en Windows, Linux y macOS, sin alternativas de entorno, compilación local,
  registro de archivos, shell en espera ni procesos de Node.
- Las rutas nativas de search, patch, download, media, recall, webhook y sesión ahora
  aplican recursos acotados, una propiedad más estricta y comprobaciones reforzadas de transporte y
  cadena de suministro de versiones.
- La extracción del runtime de memoria ahora acepta enlaces verificados dentro del archivo y sigue
  rechazando el recorrido de rutas, enlaces externos y entradas tar especiales.
- El proyecto de escritorio, el terminal, la actualización, el emparejamiento remoto, el relé y el comportamiento de paneles
  ahora incluyen las correcciones consolidadas de seguridad, recuperación y diseño adaptable.

## v0.9.124 - 2026-08-12

- La actividad de agentes del escritorio ahora agrupa cada sesión activa independientemente de la
  pestaña con foco, mientras los paneles de sesión restaurados se precalientan correctamente y las sesiones
  existentes aceptan entrada de seguimiento sin esperar a la confirmación del host.
- El transporte de sesiones entre escritorio y daemon ahora sobrevive a carreras de arranque, sesiones de
  control obsoletas, pérdidas transitorias de socket y recuperación de streams en el sitio, a la vez que
  mantiene la propiedad remota global ante cambios de foco de sesión.
- Las preferencias de commit de Git ahora separan el ejemplo visible de las instrucciones
  de IA, serializan los guardados superpuestos y validan y luego corrigen la salida de
  Conventional Commit antes de aceptarla.
- La memoria central ahora refleja el contexto curado y generado en un archivo atómico
  protegido por revisión, de modo que las sesiones puedan cargar memoria con alcance sin arrancar en frío
  el runtime de memoria, y las mutaciones actualizan el reflejo.
- El anclaje de la transcripción de la TUI y el manejo de la selección con Escape evitan saltos visuales y
  restauraciones accidentales de la cola, mientras que la alternativa por rechazo de Terminal-Bench sigue
  el motivo de terminación del runtime incluso tras narración en streaming.

## v0.9.123 - 2026-08-12

- La configuración de proveedores del escritorio ahora recupera sesiones de control obsoletas sin exponer
  fallos de transporte sin procesar, y el historial de prompts solo se activa desde un borrador vacío.
- La búsqueda de rutas evita barridos completos del árbol en frío, fusiona los precalentamientos del observador y
  ajusta los plazos de búsqueda nativa, la concurrencia masiva y las instantáneas de procesos.
- La guía de tiempo de espera del shell asíncrono ahora distingue el trabajo ilimitado en segundo plano de
  los plazos de terminación explícitos.

## v0.9.122 - 2026-08-11

- Las reglas de enrutamiento de herramientas ahora centralizan las convenciones de rutas, eliminan la guía de
  batching duplicada y exigen una inspección de solo lectura únicamente cuando la evidencia corre riesgo.
- La comprobación previa de benchmark de Anthropic ahora resuelve correctamente las importaciones del proveedor desde
  instantáneas temporales aisladas del arnés.

## v0.9.121 - 2026-08-11

- Las reglas de ejecución de herramientas y los diagnósticos de shell ahora distinguen fallos de ruta
  concluyentes, confían en sobres verificados, mantienen las comprobaciones de valores del mismo turno y exponen
  los hechos de comando no encontrado desde stderr.
- La virtualización de la transcripción del escritorio ahora fija los extremos de selección nativa de texto
  durante el autodesplazamiento al arrastrar, mientras los lanzadores de utilidades alinean su icono y texto en
  filas del tamaño del contenido.

## v0.9.120 - 2026-08-11

- Las tareas de shell en segundo plano ahora conservan su sesión propietaria y su daemon tras desvincularse
  todas las vistas, de modo que el desalojo por inactividad no pueda cancelar la tarea antes de que se
  entregue su finalización.

## v0.9.119 - 2026-08-11

- Las compilaciones de reproducibilidad de Native Graph y Token ahora se ejecutan en runners independientes
  en paralelo, mientras las subidas de DMG y ZIP de macOS Intel se solapan y abandonan
  rápidamente las transferencias detenidas.
- La navegación de proyectos del escritorio, las superficies de utilidades, el foco de la transcripción y el comportamiento de
  virtualización incluida se refinan junto con estilos de ejecución de herramientas más ajustados
  y la reutilización de procesos del sistema de archivos.
- El manejo de adjuntos de Discord y Telegram conserva la entrega de medios acotada
  y valida directamente el comportamiento de subida de Telegram.

## v0.9.118 - 2026-08-11

- El escritorio consolida Agentes, Buscar y Control de código fuente en el dock de utilidades,
  mantiene Utilidades seleccionado al lanzar herramientas, y alinea el tratamiento de advertencias frente a
  fallos en las tarjetas de herramientas restauradas y en vivo.
- El listado de archivos y la búsqueda nativa ahora fusionan la enumeración concurrente, admiten
  solicitudes persistentes cancelables e instantáneas de procesos, y conservan el comportamiento
  de alternativa acotado bajo una fuerte dispersión del sistema de archivos.
- El batching de code-graph, la reutilización de PowerShell en espera, el seguimiento del árbol de procesos de shell
  y la invalidación de cachés se refuerzan frente al trabajo concurrente y el estado obsoleto.

## v0.9.117 - 2026-08-11

- El envío de prompts en el escritorio ahora admite poner en cola de inmediato con Enter y la restauración
  precisa con Esc del texto y los adjuntos pendientes, mientras el desplazamiento de la transcripción
  aplaza las correcciones del virtualizador durante el movimiento activo del lector.
- Utilidades del escritorio ahora presenta lanzadores directos de Studio, Terminal y Explorador
  con descripciones localizadas, mientras el carril de actividad usa la identidad creativa de
  Utilidades y una presentación de uso renovada.
- Se eliminan las acciones de canal obsoletas orientadas al modelo y su infraestructura de
  despacho de proveedor, para que el catálogo de herramientas anunciado coincida con la superficie del runtime.
- La guía de ejecución de herramientas ajusta la evidencia agrupada y la verificación en el mismo turno,
  mientras las ráfagas concurrentes de sistema de archivos, grafo, patch y shell ganan un manejo acotado
  de threadpool, carriles de arranque y presión de alcanzabilidad.

## v0.9.116 - 2026-08-11

- El análisis de rondas H5 de Terminal-Bench añade trazas de tareas recompensadas y recuentos
  agregados de rondas para la comparación final de esfuerzo alto.

## v0.9.115 - 2026-08-11

- El análisis de rondas H4 de Terminal-Bench registra sondeos de tareas de esfuerzo alto exitosos
  y su cadencia de recuperación, parche y verificación.
- La guía de ejecución de herramientas ahora trata los hechos de la tarea y las comprobaciones demostradas como estado
  conocido duradero y mantiene la verificación del parche en el mismo turno de ejecución.

## v0.9.114 - 2026-08-11

- Las identidades de herramientas adivinadas ahora se verifican antes de las llamadas dependientes, con un análisis
  de rondas H3 de Terminal-Bench que registra los patrones de recuperación resultantes.

## v0.9.113 - 2026-08-11

- La guía de herramientas ahora agrupa muestras de evidencia distintas y evita la activación redundante de
  herramientas diferidas o de proyectos, con un análisis de rondas de Terminal-Bench
  que captura los patrones restantes de sondeo en serie.

## v0.9.112 - 2026-08-11

- Las superficies de utilidades, actividad, transcripción, ajustes y repositorio del escritorio se
  simplifican en torno a una configuración de funciones enfocada y regresiones compactas.
- La recuperación del proveedor, los diagnósticos de shell/list y la verificación de versiones se
  consolidan en suites más pequeñas y críticas para la publicación sin debilitar sus
  contratos de transporte, recursos o empaquetado.

## v0.9.111 - 2026-08-11

- La navegación por el repositorio ahora usa la superficie directa de herramientas integradas sin un
  agente explorador separado, reduciendo la sobrecarga de enrutamiento y la configuración heredada.
- Las decisiones de reintento de WebSocket de OpenAI conservan los errores actuales de autenticación, limitación y
  cancelación, mientras se refuerzan la recuperación del transporte de sesiones y la deduplicación
  de finalizaciones.
- El batching de herramientas, la dispersión del grafo, los informes de progreso y el comportamiento de la transcripción,
  los ajustes y el dock de utilidades del escritorio se simplifican con regresiones específicas.
- Los perfiles de Terminal-Bench 2.1, las ejecuciones reanudables, las instantáneas inmutables del arnés y
  la contabilidad de costes se ajustan para comparaciones nativas reproducibles.

## v0.9.110 - 2026-08-11

- Los transportes de proveedor ahora acotan los bloqueos sin streaming de Anthropic, distinguen
  los fallos de transporte reintentables de los rechazos del modelo, conservan la continuidad de
  razonamiento de OpenAI al recuperarse y precalientan sesiones WebSocket compatibles.
- Las herramientas patch, list y shell resuelven en una sola llamada discrepancias únicas de ruta o contexto
  conservando las salvaguardas contra ambigüedad, enlaces simbólicos y comandos destructivos.
- La finalización de títulos de sesión y el manejo de la alternativa de código fuente Markdown son más
  resistentes, con regresiones específicas de proveedor, renderer, herramientas y enrutamiento.
- Se amplían los diagnósticos de Terminal-Bench 2.1, las líneas base nativas justas, la contabilidad de uso y
  los experimentos reproducibles de reproducción de razonamiento.

## v0.9.109 - 2026-08-10

- Los comandos de shell que terminan con una salida distinta de cero se tratan como resultados de comando
  en lugar de fallos de herramienta, con un estado coherente en el runtime y la TUI.
- El enrutamiento de herramientas, los límites del explorador, los contratos de estilo de salida y sus suites de
  regresión se ajustan para evitar trabajo redundante conservando informes concisos de cara al
  usuario.
- Las raíces de parche compactas ahora establecen tanto el límite de escritura como el marco de coordenadas
  de rutas relativas, incluida una guía de recuperación más clara.

## v0.9.108 - 2026-08-10

- El análisis de parches compactos acepta envoltorios Begin/End heredados alrededor de las
  secciones compactas dejando intacta la entrada canónica V4A.

## v0.9.107 - 2026-08-10

- Las sesiones de automatización no interactiva y de benchmark usan explícitamente un contexto de
  aprobación implícita, mientras los workflows interactivos mantienen su puerta de aprobación del usuario.

## v0.9.106 - 2026-08-10

- Los clientes MCP, el descubrimiento de herramientas, las instrucciones, la ejecución, la actualización diferida y
  el cierre se aíslan por ámbito de runtime para que servidores con el mismo nombre no puedan filtrarse
  entre sesiones concurrentes ni agentes independientes.

## v0.9.105 - 2026-08-10

- El acceso remoto es solo de aplicación web: el paquete Capacitor/Android retirado,
  las rutas de descarga de APK, los hooks de shell nativo y el cableado de versión de la versión
  móvil se eliminan, mientras el despliegue del relé gana un paso explícito de preparación del renderer.
- Las llamadas a herramientas ahora normalizan las entradas del proyecto actual a rutas relativas compactas,
  rechazan de forma coherente los ámbitos discordantes o redundantes y conservan la paridad
  entre los contratos de shell, patch, graph, explore y herramientas integradas.
- El informe de contexto separa el uso visible para el proveedor de la presión de compactación
  y la reserva configurada, mientras el pensamiento adaptativo de Anthropic deja su modo de
  visualización a la API salvo que un operador lo anule explícitamente.
- Los borradores de nuevas tareas conservan su propia pestaña de proyecto al seleccionar o registrar un
  proyecto, y los cambios correctos de Fast de la sesión inicializan el siguiente borrador coincidente
  sin reemplazar una elección de modelo distinta.

## v0.9.104 - 2026-08-09

- El enrutamiento de herramientas ahora localiza una vez las coordenadas desconocidas del repositorio, asigna cada
  faceta de evidencia a una herramienta dedicada, agrupa solo llamadas independientes y
  mantiene las ediciones de texto y la verificación tras la barrera de ejecución de patch.
- La inspección de directorios expone archivos de punto y metadatos de archivos sin exploración
  por Shell, mientras los workflows sin delegación omiten el brief de Lead sin uso y
  usan una superficie de herramientas más pequeña y alineada con las capacidades.

## v0.9.103 - 2026-08-08

- Las superficies de navegación, compositor, Studio, ajustes y transcripción del escritorio ahora
  comparten un diseño adaptable más ajustado, con un seguimiento de desplazamiento virtual más sólido, manejo
  de archivos locales y una cobertura de regresión DOM ampliada.
- El renderer remoto se distribuye como una aplicación web instalable con manifiesto estable,
  icono y un service worker solo de red, mientras el relé sirve esos recursos
  con los tipos de contenido requeridos de manifiesto y service worker.
- La ejecución Solo ya no lleva definiciones de agentes obsoletas de depurador, tarea del programador o
  manejador de webhooks y elimina su protocolo de enrutamiento/caché obsoleto, manteniendo los servicios
  integrados separados de los agentes personalizados editables.
- La generación de imágenes de Codex alojado selecciona explícitamente la herramienta de imagen para los modelos
  compatibles, con cobertura específica del cuerpo de la solicitud.

## v0.9.102 - 2026-08-08

- Subida de versión de mantenimiento; sin cambios funcionales respecto a v0.9.101.

## v0.9.101 - 2026-08-08

- Escape ahora recupera en el compositor los mensajes en cola aún sin procesar
  antes que cualquier otra cosa —primero el orden de la cola—, de modo que un Esc a mitad de turno edita
  el seguimiento en espera en lugar de interrumpir el turno; una segunda pulsación sigue
  cancelando.
- Los workflows son definiciones puras de estilo de trabajo: los paquetes ya no llevan una lista de
  agentes. Todo agente definido (integrado y personalizado) está disponible para cualquier
  workflow que delegue, Solo sigue sin delegación mediante `delegation: none`, y
  borrar un agente personalizado lo elimina de todas las superficies a la vez, incluido
  el lanzamiento por nombre.
- Ajustes → General ganó interruptores independientes de Web search, Explorer y Memoria;
  Memoria ahora controla las herramientas de memoria/recall más la inyección de memoria central,
  mientras que los ciclos de memoria en segundo plano pasaron a Contexto como su propio
  interruptor.
- Las ejecuciones de roles headless y las sesiones de benchmark empiezan con explorer, búsqueda web y
  memoria desactivados (superficie clásica) y se reactivan por ejecución mediante opciones o
  variables MIXDOG_FEATURE_*.
- La política de herramientas compartida elimina la ronda obligatoria de verificación posterior a la edición,
  toma la evidencia suficiente más barata en cada consulta y define explore como una
  búsqueda de código simple sobre árboles de fuentes y archivos con un destino concreto por
  consulta.

## v0.9.100 - 2026-08-07

- El estilo del comando de contexto ya no depende de abrir Ajustes primero ni
  choca con la clase de contexto global de Monaco, y la reconexión de la transcripción ya
  no revierte un pequeño movimiento de rueda del lector.
- Los empaquetadores de escritorio ahora restauran las descargas de npm con una clave de caché solo de dependencias,
  de modo que los sellos de versión no arranquen en frío cada instalación de plataforma.
- Los borradores ocultos se tratan como trabajo reanudable en lugar de versiones publicadas,
  evitando que las versiones fallidas consuman una versión de parche adicional.

## v0.9.99 - 2026-08-07

- La tipografía de la transcripción del escritorio ahora separa contenido, estado operativo y
  metadatos en una jerarquía más estable, mientras Fast usa un icono compacto con estado.
- La recuperación del explorador ahora expande una vez cada faceta de localizador concreta, conserva
  literalmente las rutas devueltas y detiene la recuperación acotada en lugar de devolver un
  anclaje débil o reconstruido.
- Las lecturas síncronas del catálogo de modelos ya no lanzan una solicitud de red global implícita.
  El calentamiento de sesión sigue siendo el único responsable de la E/S del catálogo remoto, de modo que los
  transportes inyectados por el proveedor siguen siendo herméticos en una instalación en frío.
- El carril de versión aislado ahora prepara explícitamente un único runtime verificado de code-graph nativo
  en lugar de depender de un binario ambiente dejado por un trabajo anterior.
- Los recursos de versión de macOS Intel usan subidas HTTP/1.1 acotadas, archivo por archivo, con
  comprobaciones de finalización remotas y reintentos, evitando que una transferencia de CLI detenida
  mantenga retenida indefinidamente toda la versión.
- La recuperación de versiones no publicadas de la misma versión ahora integra sus notas acumuladas
  en esa versión antes de publicar en lugar de dejar trabajo ya distribuido marcado
  como Unreleased.

## v0.9.98 - 2026-08-07

- El emparejamiento del navegador remoto ahora establece un canal cifrado de extremo a extremo autenticado
  antes de que cualquier estado de sesión, dato de terminal o carga RPC pueda cruzar el
  relé; los carriles de medios sin cifrar permanecen cerrados.
- Los adjuntos del escritorio conservan la identidad y los metadatos del archivo a través del límite de
  sesión, con extracción acotada de imagen/PDF y normalización de medios compartida
  para las entradas del proveedor.
- La incorporación del escritorio y los textos de ajustes relacionados están localizados en todos los idiomas
  distribuidos, mientras la composición IME, el seguimiento de la transcripción virtual y los
  controles del modo rápido se comportan de forma coherente en paneles de larga duración.
- La recuperación de sesiones, la entrega de mensajes pendientes, la caché del catálogo de proveedores, la generación
  de títulos, las instantáneas de worktree y las métricas acotadas de runtime se ajustan
  en torno al servicio de sesiones unificado.
- La validación de versiones se divide en carriles paralelos, la compilación del escritorio se solapa con
  las puertas, los runtimes preparados se cachean y los paquetes de plataforma se suben a un único
  borrador oculto antes de la publicación atómica. Las dependencias solo del renderer ya no
  se duplican en el archivo del escritorio, lo que reduce el instalador de Windows en
  aproximadamente un tercio.

## v0.9.97 - 2026-08-07

- El protocolo de sesión 1 ahora lleva un índice de compatibilidad explícito, lo que permite que
  los clientes más nuevos rechacen daemons antiguos mientras los clientes antiguos pueden conectarse mediante la
  superficie de compatibilidad admitida sin pilas paralelas de engine/backend.
- Los flujos de escritorio, terminal, canal, OAuth y memoria ahora comparten el daemon de sesiones
  unificado de toda la máquina; los transportes, alternativas y adaptaciones de compatibilidad obsoletos
  de engine/backend se han eliminado de la línea de desarrollo.
- La propiedad de sesiones y las puertas de carga de herramientas ahora coordinan el trabajo paralelo de shell,
  patch, read, code-graph, memoria y canal con admisión justa,
  menos E/S duplicada y una cobertura más sólida de cancelación/recuperación.
- Se han ajustado el foco multipanel del escritorio, el arrastre de pestañas, el estado de revisión, las notificaciones, el
  nombrado de proveedores, los diagnósticos del actualizador y el empaquetado de actualizaciones de desarrollo,
  con pruebas de regresión ampliadas del renderer y del transporte de sesiones.
- Los comandos de reproducción de Terminal-Bench y la validación de costes ahora apuntan a la
  ejecución archivada exacta y fallan con claridad cuando falta un conjunto de pruebas solicitado.

## v0.9.96 - 2026-08-07

- La disciplina de versiones ahora exige que cada paquete de aplicación se suba previamente cuando
  cambia el protocolo de cable del engine, mantiene sincronizadas las versiones del workspace y
  publica esa identidad pendiente sin un segundo incremento accidental.
- Las superficies de desarrollo e instaladas siguen compartiendo el almacén existente de datos y
  autenticación; la disciplina de protocolo/versión evita el desfase del daemon con la misma versión
  sin ocultar credenciales tras un nuevo perfil.
- La validación de versiones ahora controla el empaquetado de plataformas y elimina una ejecución duplicada de
  code-graph, evitando cinco costosos trabajos de paquetes cuando falla una puerta específica.
- Los conflictos de protocolo del escritorio ahora explican la ruta de recuperación de actualizar/cerrar y volver a abrir
  en lugar de mostrar una excepción de transporte de sesión sin procesar.
- El daemon unificado de protocolo 1 elimina el host de sesión de escritorio duplicado,
  restaura el comportamiento de reconexión/resincronización del daemon y conserva el trabajo de herramientas completado
  a través de los límites de tiempo de espera y cancelación.

## v0.9.95 - 2026-08-06

- Un proceso global de la máquina es dueño de cada sesión en vivo, y la TUI del terminal más
  cada ventana de escritorio se conectan como vistas sobre un transporte HTTP+SSE en 127.0.0.1, de modo que
  no hay un rol de propietario/espectador que negociar entre superficies.
- Los prompts enviados ya no pueden perderse entre superficies. El envío de una vista del daemon
  mantiene su respuesta síncrona pero se reintenta hasta que el engine lo toma
  (y se reentrega tras un reinicio del daemon), el envío de un live-share es
  confirmado por el propietario y recurre al spool duradero cuando se rechaza o no
  se confirma, y la cola descarta un id de envío reentregado
  en lugar de publicar el mensaje dos veces.
- Edición entre clientes: reanudar una sesión que otra vista ya mantiene adopta
  ese engine en vivo en lugar de cargar una segunda copia, los fotogramas del engine se distribuyen a
  cada vista, y un engine solo termina con su ÚLTIMO espectador, de modo que un terminal y
  una ventana de escritorio pueden dirigir una sesión turno a turno.

## v0.9.94 - 2026-08-05

- La barra de pestañas del escritorio encoge las pestañas conjuntamente hacia los mínimos de activa/inactiva
  con todas las pestañas visibles en lugar de desplazarse, y los shells táctiles se contraen a una
  lista de conmutador de título + recuento.
- El markdown en streaming repara la cola en vivo (`**`, `` ` ``, `~~` sin cerrar) y
  limita el bloqueo de geometría del código delimitado a su propio fragmento, de modo que los encabezados, listas
  y negritas se formatean mientras el modelo aún escribe.
- La revisión de turno se movió a la línea de tiempo con desplazamiento (los diffs de turno viajan con
  el hilo), terminando con el desplazamiento de la pila del compositor al entrar en una sesión; los avisos de tono
  de advertencia ahora usan el par de estado ámbar en lugar del neutro.
- La banda de título nativa es transparente para que la barra de título DOM y los velos de los diálogos
  la atenúen directamente; el par ◀ ▶ de ciclo de paneles se retira (Alt+Izquierda/Derecha mantiene
  el ciclo de foco) y los diálogos de proyecto mantienen el reclamo de atenuación de la barra de título.
- La captura de la interfaz de escritorio maneja Nueva tarea y Ajustes mediante Ctrl+N / Ctrl+,,
  fija el idioma de captura y comprueba el diseño estrecho de ajustes de 360px.
- Refinamientos del arnés de ventana de transcripción y jitter de la TUI, además de sondas de
  carreras de selección de sesión en el escritorio.

## v0.9.93 - 2026-08-04

- Auditoría de dependencias a cero en el núcleo y el escritorio: `npm audit fix` para
  fast-uri, ip-address, hono/@hono/node-server, undici raíz y
  brace-expansion; la anulación de undici anidado de discord.js elevada a 6.28.0;
  la anulación `^3.4.12` de `dompurify` del escritorio resuelve el lote de XSS de Monaco.
- Auditoría de funciones del README: sección del banco de trabajo de escritorio, detalle del subsistema de memoria,
  emparejamiento QR por relé, cron con horas de silencio y transcripción local con Whisper,
  sesiones de paneles en paralelo, asistente de incorporación.
- Discord: se eliminó el último comando de barra registrado (`/stop`); el arranque sigue
  borrando los conjuntos obsoletos de comandos globales/de servidor.
- Terminal-Bench 2.1: resultados corregidos, gráficos de comparación de reemplazo y
  scripts de reproducción/verificación.
- CI: Deploy es ahora el único punto de entrada de versiones (la cadena de suministro de tokens se integró,
  se eliminaron las puertas laterales de push de tags) con una puerta de changelog de versión.
- Versiones de paquetes unificadas en 0.9.92 (móvil/relé alineados) e historial del
  repositorio aplastado hasta una raíz limpia.

## v0.9.92 - 2026-08-02

- Versión base: paquete npm, instaladores de escritorio y recursos de la cadena de suministro nativa
  (runtime, patch, graph, token, runtime de voz).
