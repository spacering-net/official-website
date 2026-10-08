-- Data version 2: ring cards (see 0001 for the conventions).
--
-- A ring card is a holder's ring number, with the date the ring was forged,
-- shown at /ring/<number>/ and as a picture for link previews. Cards are
-- private until shared: a row here means its holder has shared it, and
-- deleting the row stops sharing. Whether it also shows the holder's name and
-- picture is their choice, and off unless they turn it on.
CREATE TABLE ring_cards (
  user_id    TEXT    PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  show_name  INTEGER NOT NULL DEFAULT 0 CHECK (show_name IN (0, 1)),
  show_image INTEGER NOT NULL DEFAULT 0 CHECK (show_image IN (0, 1)),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;
