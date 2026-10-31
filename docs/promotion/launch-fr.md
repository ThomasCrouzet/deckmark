# Launch post, French

Statut : préparé, non publié.

## mdsh 2.1.0 ajoute un éditeur de diapositives hors ligne

mdsh est un espace de travail Markdown local. La version 2.1.0 ajoute une
quatrième vue : Diapositives.

Écrivez un document, puis sélectionnez **Slides** pour placer du texte, des images,
des formes et des connecteurs sur un canevas. Ajoutez des notes de présentateur,
réorganisez les diapositives et lancez la présentation en plein écran. Utilisez le
clavier ou un écran tactile. Le même diaporama s'exporte en Markdown, en HTML
portable, en PDF et vers l'impression. Le PDF et l'impression placent une
diapositive par page et excluent les notes du présentateur.

Une présentation reste un seul fichier Markdown. Un en-tête YAML facultatif, le
contenu Markdown et un bloc terminal `mdsh-presentation` partagent le fichier. Le
texte et les images restent lisibles dans un autre éditeur. Si un fichier utilise
une version inconnue, l'éditeur affiche une erreur et ne modifie pas le fichier. Un
document ordinaire ouvert puis fermé sans modification de disposition garde ses
octets exacts.

Le reste du produit conserve son fonctionnement local. Les brouillons restent dans
IndexedDB avec le même délai d'enregistrement de 400 ms. La bibliothèque, la
recherche, la corbeille, l'historique, les liens disque, les sauvegardes et les
exports traitent une présentation comme un document normal. La PWA fonctionne
toujours hors ligne dès la première utilisation, et l'éditeur de diapositives ne se
charge que lorsqu'un document en a besoin.

La version 2.1.0 est disponible dans l'application web et comme préversion Desktop
Beta. Les installateurs de bureau restent non signés et peuvent afficher un
avertissement du système. Vérifiez les sommes de contrôle publiées avant
l'installation.

Limites : l'édition visuelle peut normaliser le Markdown. Utilisez le mode Source
si la mise en forme exacte compte. La synchronisation cloud, la collaboration et
les extensions restent hors du périmètre du projet.

Liens : https://thomascrouzet.github.io/mdsh/ et
https://github.com/ThomasCrouzet/mdsh/releases
