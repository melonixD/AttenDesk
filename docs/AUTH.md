# How people sign in, and where it is weak

AttenDesk now has three sign-in paths. They are not equally strong, and it is
worth being clear about that before the pilot.

## Admin and teacher — username + password

Passwords are hashed with scrypt (N=16384, r=8, p=1) and a per-user 16-byte
salt. Nothing reversible is stored. Comparison is constant-time, and a login
attempt for an account that does not exist spends the same work as one that
does, so the endpoint cannot be used to enumerate staff.

Accepted identifiers: username, college email, or full name. All three need the
password.

## Student — full name + roll number

**This is the weakest part of the system and you should plan to replace it.**

A roll number is not a secret. It is printed on the ID card, it appears on
noticeboards, and classmates know each other's. Anyone who knows a student's
name and roll number can sign in as them.

Three things still stand between that and a false attendance record:

1. **Device binding.** The first browser to sign in becomes that student's
   registered device. A second browser is refused and has to go through an
   admin-approved device-change request.
2. **The rotating classroom beacon.** Attendance needs a code that an ESP32
   inside the room is broadcasting right now, and that code changes every 30
   seconds.
3. **The ID-card barcode**, scanned with the camera at the moment of marking.

Point 3 is doing less work than it looks like it is. **The barcode on the HBTU
card encodes the roll number** — the same value used to log in. So it proves
possession of *a* card bearing that number, not that the right person is
holding it, and a photograph of a classmate's card would pass.

Points 1 and 2 are the real defences. A proxy would need the victim's name and
roll number, physical presence in the classroom during the window, *and* to be
the first device ever registered for that account.

### Making it stronger

Set `STUDENT_REQUIRE_PASSWORD=true` and give students passwords. The login
route already enforces it; seed passwords with `SEED_STUDENT_PASSWORD`, or have
each student set one on first sign-in. This is a one-line configuration change
and it closes the gap. I would do it before the system produces attendance
records anybody's degree depends on.

## Email OTP — fallback

The Android student app uses the password assigned by an administrator as its primary sign-in method. Mobile password login requires the student's registered full name, roll number, assigned password and installation ID. Accounts without a stored password are refused on mobile until an administrator sets one from **People**. Email OTP remains available as a fallback when production email delivery is configured.

The original passwordless flow is intact at `/api/auth/request-otp`. Codes are
six digits, hashed with a keyed HMAC, valid ten minutes, single use, five
attempts. It needs `RESEND_API_KEY` and a verified sending domain. Useful if
somebody forgets a password.

## Tokens

- Access token: HS256, 15 minutes, carries role, org and (for students) the
  bound installation ID.
- Refresh token: 48 random bytes, stored hashed, rotated on every use, 30 days.
- `users.status` is re-read on every authenticated request, so suspending an
  account takes effect immediately rather than at token expiry.
- Changing a password revokes every refresh token for that user.
