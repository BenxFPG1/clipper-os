-- Eén keer draaien in de Supabase SQL-editor (project clipper-os).
--
-- Waarom: app_users en sessions waren leesbaar met de publieke sleutel. In
-- app_users stonden wachtwoorden in leesbare tekst, in sessions geldige
-- sessietokens. De app logt nu alleen nog in via Google; deze tabellen en
-- kolommen zijn niet meer nodig.

alter table if exists app_users enable row level security;
alter table if exists app_users drop column if exists password;
drop table if exists sessions;
drop table if exists password_access_log;
drop table if exists users;

-- Controle: alle tabellen in public horen RLS aan te hebben. Deze query hoort
-- geen rijen terug te geven.
select tablename from pg_tables
where schemaname = 'public' and not rowsecurity;
