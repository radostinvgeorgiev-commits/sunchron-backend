# Google Cloud data verification

Production данните са във Firestore, а профилите са в Identity Platform.
Останалите migration скриптове са еднократни offline инструменти и не са
runtime fallback.

Преди import или cleanup:

1. създай read-only inventory без лични стойности;
2. провери owner isolation и броя на документите;
3. използвай private Cloud Run Job с отделна service identity;
4. изпълни dry run;
5. импортирай идемпотентно и запази audit summary;
6. тествай вход, памет, workspace, задачи и OAuth сесии;
7. изтрий временните права и ресурси само след изрично разрешение.

Restore тестът трябва да е изолиран, да има показана цена и cleanup план и да
не променя production данните.
