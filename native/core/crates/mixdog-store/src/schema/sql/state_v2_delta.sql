-- state/core.sqlite, user_version 1 -> 2: the registry name a project is listed under.
-- Node keeps it in the project registry apart from the preferences alias: a rename sets both, but a project removed and added
-- again gets its folder name back while the alias stays. NULL: not recorded (a v1 row or an imported one), listed under
-- the alias, else the folder name.
ALTER TABLE projects ADD COLUMN name TEXT;
PRAGMA user_version = 2;
