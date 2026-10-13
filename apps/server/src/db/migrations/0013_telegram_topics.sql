-- На что подписан привязанный чат: утренняя сводка, новые позиции в стоп-листе, горячие блюда в сводке.
-- По умолчанию то, что бот присылал и раньше в общий чат
ALTER TABLE telegram_links ADD COLUMN topics text[] NOT NULL DEFAULT ARRAY['digest', 'stoplist'];
