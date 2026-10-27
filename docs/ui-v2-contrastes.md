# Contrastes des tokens v2

Calculés par `node scripts/contrast-tokens.mjs src/renderer/src/styles.css` (texte ≥ 4,5 ; éléments graphiques ≥ 3).

| Thème  | Token                 | Fond : ratio                                                 | Min |     |
| ------ | --------------------- | ------------------------------------------------------------ | --- | --- |
| sombre | fg `#e5e9f0`          | panel 14.85 · surface 13.53 · surface-2 12.10 · canvas 15.27 | 4.5 | ✅  |
| sombre | fg-muted `#a3acba`    | panel 7.89 · surface 7.19 · surface-2 6.43 · canvas 8.12     | 4.5 | ✅  |
| sombre | fg-subtle `#8590a0`   | panel 5.59 · surface 5.09 · surface-2 4.56 · canvas 5.75     | 4.5 | ✅  |
| sombre | accent-text `#93c5fd` | panel 10.03 · surface 9.14 · surface-2 8.17 · canvas 10.31   | 4.5 | ✅  |
| sombre | ok-text `#4ade80`     | panel 10.38 · surface 9.45 · surface-2 8.46 · canvas 10.67   | 4.5 | ✅  |
| sombre | warn-text `#fbbf24`   | panel 10.83 · surface 9.87 · surface-2 8.83 · canvas 11.14   | 4.5 | ✅  |
| sombre | danger-text `#f87171` | panel 6.54 · surface 5.96 · surface-2 5.33 · canvas 6.72     | 4.5 | ✅  |
| sombre | info-text `#93c5fd`   | panel 10.03 · surface 9.14 · surface-2 8.17 · canvas 10.31   | 4.5 | ✅  |
| sombre | on-accent `#ffffff`   | accent 5.17 · accent-hover 6.70                              | 4.5 | ✅  |
| sombre | on-danger `#111827`   | danger 4.71                                                  | 4.5 | ✅  |
| sombre | ok `#22c55e`          | panel 7.94 · canvas 8.16                                     | 3   | ✅  |
| sombre | warn `#f59e0b`        | panel 8.42 · canvas 8.66                                     | 3   | ✅  |
| sombre | danger `#ef4444`      | panel 4.81 · canvas 4.94                                     | 3   | ✅  |
| sombre | idle `#6b7280`        | panel 3.74 · canvas 3.85                                     | 3   | ✅  |
| sombre | focus `#3b82f6`       | panel 4.92 · canvas 5.06                                     | 3   | ✅  |
| clair  | fg `#111827`          | panel 17.74 · surface 17.74 · surface-2 16.12 · canvas 16.84 | 4.5 | ✅  |
| clair  | fg-muted `#4b5563`    | panel 7.56 · surface 7.56 · surface-2 6.87 · canvas 7.17     | 4.5 | ✅  |
| clair  | fg-subtle `#5f6773`   | panel 5.72 · surface 5.72 · surface-2 5.19 · canvas 5.43     | 4.5 | ✅  |
| clair  | accent-text `#1d4ed8` | panel 6.70 · surface 6.70 · surface-2 6.09 · canvas 6.36     | 4.5 | ✅  |
| clair  | ok-text `#15803d`     | panel 5.02 · surface 5.02 · surface-2 4.56 · canvas 4.76     | 4.5 | ✅  |
| clair  | warn-text `#b45309`   | panel 5.02 · surface 5.02 · surface-2 4.56 · canvas 4.77     | 4.5 | ✅  |
| clair  | danger-text `#b91c1c` | panel 6.47 · surface 6.47 · surface-2 5.88 · canvas 6.14     | 4.5 | ✅  |
| clair  | info-text `#1d4ed8`   | panel 6.70 · surface 6.70 · surface-2 6.09 · canvas 6.36     | 4.5 | ✅  |
| clair  | on-accent `#ffffff`   | accent 5.17 · accent-hover 6.70                              | 4.5 | ✅  |
| clair  | on-danger `#111827`   | danger 4.71                                                  | 4.5 | ✅  |
| clair  | ok `#16a34a`          | panel 3.30 · canvas 3.13                                     | 3   | ✅  |
| clair  | warn `#d97706`        | panel 3.19 · canvas 3.02                                     | 3   | ✅  |
| clair  | danger `#ef4444`      | panel 3.76 · canvas 3.57                                     | 3   | ✅  |
| clair  | idle `#6b7280`        | panel 4.83 · canvas 4.59                                     | 3   | ✅  |
| clair  | focus `#2563eb`       | panel 5.17 · canvas 4.91                                     | 3   | ✅  |
