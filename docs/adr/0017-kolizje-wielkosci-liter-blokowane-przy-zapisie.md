# ADR 0017: Kolizje wielkości liter blokowane przy zapisie do biblioteki

Status: zaakceptowane, uzupełnione przez ADR 0057
Data: 2026-10-20

> Uzupełnienie wprowadzone przez ADR 0057: kandydat z konfliktem nazwy można w kreatorze importu
> zaimportować pod nowym slugiem podanym przez użytkownika. Nazwa ze źródła trafia do aliasów,
> a kolizja `lower(slug)` nadal blokuje zapis. Nie ma cichego sufiksu.

## Kontekst

macOS APFS i Windows NTFS są domyślnie nieczułe na wielkość liter, ext4 na Linuksie jest czuły.
Biblioteka zbudowana na Linuksie może zawierać `code-review` i `Code-Review` jako dwa osobne
elementy, które na macOS i Windowsie zderzą się w jeden plik.

Problem dotyczy też nazw po sanityzacji: dwie różne nazwy źródłowe mogą dać ten sam bezpieczny
slug.

## Rozważane opcje

**Blokować przy eksporcie.** Wygląda logicznie, bo kolizja objawia się na systemie docelowym.
Jest jednak najgorszym momentem: użytkownik ma już dwa elementy, zainwestował w oba, i nie ma
dobrej odpowiedzi na pytanie, który poświęcić. Dodatkowo kolizja ujawniłaby się tylko przy
eksporcie na system nieczuły, czyli użytkownik Linuksa dowiedziałby się o niej od kogoś innego.

**Blokować przy zapisie do biblioteki.** W tym momencie jeden z elementów właśnie powstaje,
więc odpowiedź jest oczywista: zmień nazwę nowego.

**Pozwalać i rozwiązywać automatycznie przy eksporcie przez dopisanie sufiksu.** Cicha zmiana
nazwy elementu, czyli dokładnie to, czego wymagania zabraniają przy konwersji.

## Decyzja

Walidator biblioteki blokuje kolizję **przy zapisie do biblioteki**, nie przy eksporcie.

Klucz unikalności: `lower(slug)` plus typ elementu. Wymuszony indeksem unikalnym w bazie
i sprawdzany w walidatorze przed zapisem plików, żeby komunikat był czytelny, a nie pochodził
z naruszenia ograniczenia bazy.

Ta sama reguła obowiązuje przy imporcie masowym: element kolidujący jest raportowany w podglądzie
jako wymagający rozstrzygnięcia, a nie importowany z cichym sufiksem.

## Konsekwencje

Biblioteka jest przenośna między systemami z definicji. Katalog `library/` skopiowany z Linuksa
na macOS zawsze się rozpakuje.

Użytkownik, który ma w Claude Code dwa skille różniące się tylko wielkością liter, przy imporcie
dostanie konflikt do rozstrzygnięcia. To uciążliwe, ale jest to realna kolizja w jego konfiguracji,
a aplikacja ma ją ujawnić, nie zamaskować.

Generator ma już analogiczny mechanizm: kolizja nazw katalogów po sanityzacji przerywa bez
zapisu, a sprawdzanie idzie po nazwie złożonej do małych liter właśnie z powodu APFS. Reguła
jest przenoszalna razem z testem.
