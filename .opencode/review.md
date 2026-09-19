# Code Review Summary

**Scope**: Diff timer/history terbaru beserta alur settlement, migrasi, AI, dan UI terkait.
**Overall risk**: High
**Verdict**: Request changes

## Findings

### [P1] High

- **Pertanyaan duplikat dapat menghentikan giliran AI**
  - **Location**: `packages/backend/src/turn-repository.ts:256-264`; `packages/backend/src/ai-player-runner.ts:97-108`.
  - **Why it matters**: Game berhenti pada `waiting_for_question` sampai ada intervensi atau rekonsiliasi lain.
  - **Evidence**: Repository kini menolak pertanyaan lama dengan 409. Fallback runner hanya berlaku jika `generateQuestion` melempar error; hasil valid tetapi duplikat gagal saat `askQuestionAsAI`, lalu ditelan outer catch. Task question tidak memiliki callback rekonsiliasi atau recovery. Context evidence juga hanya memuat 30 pertanyaan answered, sedangkan pemeriksaan duplikat mencakup seluruh pertanyaan.
  - **Fix**: Tangani duplicate conflict secara eksplisit dengan regenerasi terbatas dan fallback yang diperiksa terhadap seluruh pertanyaan terdahulu; setelah retry habis, lakukan skip yang sah dan broadcast.

### [P2] Medium

- **Backfill deadline v14 kehilangan zona waktu**
  - **Location**: `packages/backend/src/db.ts:759-763`.
  - **Why it matters**: Auto-close dan countdown untuk pertanyaan hasil migrasi berbeda menurut zona waktu server/browser.
  - **Evidence**: SQLite `datetime()` menghasilkan teks tanpa `Z`; semua konsumen menggunakan `Date.parse`. Pada `TZ=Asia/Jakarta`, `2026-09-19 12:01:00` diparse menjadi `2026-09-19T05:01:00.000Z`, bukan `12:01Z`. Deadline baru menggunakan `toISOString`, sehingga format persisted tidak konsisten.
  - **Fix**: Backfill dengan ISO UTC eksplisit, misalnya `strftime('%Y-%m-%dT%H:%M:%fZ', ...)`; repair database yang sudah mencapai v14 lewat migrasi berikutnya. Uji pada timezone non-UTC.

- **Server menerima jawaban setelah deadline**
  - **Location**: `packages/backend/src/turn-repository.ts:419-448`; `packages/backend/src/ai-player-runner.ts:120-124`.
  - **Why it matters**: Pengguna API dan AI dapat menjawab/mengubah jawaban setelah UI melarangnya, lalu menerima poin.
  - **Evidence**: `submitAnswerAtomic` hanya mengecek fase, tidak mengambil atau memvalidasi deadline. Ketika moderator pending/failed, runner sengaja mempertahankan `collecting_answers` meskipun deadline lewat. INSERT/UPSERT tetap diterima selama interval tersebut.
  - **Fix**: Periksa persisted deadline menggunakan clock yang diinjeksi di transaksi submit untuk human dan AI; tolak jawaban serta perubahan pada `now >= deadline`. Pisahkan penutupan input dari kesiapan settlement moderator.

- **History lama tidak memiliki outcome setelah migrasi**
  - **Location**: `packages/backend/src/db.ts:756-765`; `packages/backend/src/game-serializer.ts:110-113`.
  - **Why it matters**: Turn lama yang sudah berakhir dapat tampil seperti tidak memiliki hasil, terutama pass/skip tanpa guess.
  - **Evidence**: Migrasi menambahkan `outcome` nullable tanpa backfill. Serializer meneruskan null dan UI hanya menampilkan pass/skip ketika outcome terisi. Guess lama masih dapat ditampilkan melalui `guess_attempts`, tetapi turn tanpa guess tidak mendapat label hasil.
  - **Fix**: Backfill `guessed` dari `guess_attempts`. Untuk pass/skip yang tidak dapat dibedakan dari data lama, tampilkan outcome legacy/unknown secara eksplisit; jangan mengarang pass atau skip. Uji migrasi dengan closed turns.

- **Pengumuman timer tertutup status AI**
  - **Location**: `packages/frontend/src/App.svelte:649-670,689`.
  - **Why it matters**: Pengguna screen reader bisa kehilangan peringatan 10 detik dan waktu habis.
  - **Evidence**: Live region memakai `aiLiveStatus || timerAnnouncement`. Aktivitas AI nonkosong selalu menang; teks last AI guess/pass juga dapat bertahan karena last action disimpan lintas turn. Perubahan timer tidak mengubah isi live region saat kondisi ini terjadi.
  - **Fix**: Gunakan antrean pengumuman dengan prioritas event timer atau live region terpisah yang terkoordinasi; reset pesan berdasarkan question ID dan deteksi perlintasan ambang `<= 10`, bukan hanya tepat 10. Uji dengan status AI aktif dan last action persisten.

## Validation

- Host settings memiliki pemeriksaan token/room, host human, integer 15–300, serta lock saat starting dan setelah game dibuat.
- Settlement menggunakan transaksi immediate, guard phase, moderator gate, dan INSERT OR IGNORE ledger; tidak ditemukan bukti pemberian poin ganda pada jalur ini.
- History menggunakan field publik eksplisit; tidak ditemukan penambahan snapshot karakter sendiri/private hints pada history atau AI self context.
- Interval UI memiliki cleanup pada unmount.
- Suite backend dicoba tetapi tidak selesai bersih: output assertion `expect(received).not.toBe(expected)`; pengulangan untuk memperoleh output lengkap timeout 120 detik. Tidak diklaim lulus.
- Parsing timezone non-UTC berhasil direproduksi. Temuan lainnya berdasarkan penelusuran kode, bukan pengujian browser.

## Suggested Next Steps

- [ ] Perbaiki recovery pertanyaan AI duplikat sebelum merge.
- [ ] Tambahkan tes deadline terlambat dengan moderator pending/failed, migrasi timezone, legacy outcomes, dan live announcement.
- [ ] Jalankan ulang suite backend serta pemeriksaan UI setelah perbaikan.
