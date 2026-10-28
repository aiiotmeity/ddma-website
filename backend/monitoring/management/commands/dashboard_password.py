import getpass
import secrets

from django.core.management.base import BaseCommand, CommandError

from monitoring import auth


class Command(BaseCommand):
    help = (
        "Set, inspect or clear the dashboard password that is saved in S3. "
        "Use it when nobody can sign in and the email reset is not available."
    )

    def add_arguments(self, parser):
        parser.add_argument("--status", action="store_true", help="Show where the password is stored and when it last changed.")
        parser.add_argument(
            "--clear",
            action="store_true",
            help="Remove the saved password so sign-in uses ARG_LOGIN_PASSWORD from .env / Render again.",
        )
        parser.add_argument(
            "--recovery-key",
            action="store_true",
            help="Generate a new recovery key for 'Forgot password?' (no email needed).",
        )

    def handle(self, *args, **options):
        location = auth.store_location()

        if options["status"]:
            data = auth._stored(force=True)
            self.stdout.write(f"Store: {location}")
            if data.get("password_hash"):
                self.stdout.write(f"Password last changed: {data.get('updated_at')} ({data.get('updated_by')})")
            else:
                self.stdout.write("No saved password. Sign-in uses ARG_LOGIN_PASSWORD from the environment.")
            self.stdout.write(f"Reset email configured: {'yes' if auth.mail_configured() else 'no'}")
            self.stdout.write(f"Recovery key configured: {'yes' if auth.recovery_configured() else 'no'}")
            return

        if options["recovery_key"]:
            key = "-".join(secrets.token_hex(2).upper() for _ in range(6))
            self.stdout.write("")
            self.stdout.write(f"Recovery key:  {key}")
            self.stdout.write("")
            self.stdout.write("1. Add this line to Render > Environment and to backend/.env:")
            self.stdout.write(f"   ARG_RECOVERY_KEY={key}")
            self.stdout.write("2. Write the key on paper and give it to the DDMA officer in a sealed envelope.")
            self.stdout.write("3. Do not save it in the frontend, GitHub, chat or email.")
            return

        if options["clear"]:
            auth.write_store({})
            self.stdout.write(self.style.SUCCESS(
                f"Cleared {location}. Sign in with ARG_LOGIN_PASSWORD, then change it from the dashboard."
            ))
            return

        password = getpass.getpass("New dashboard password: ")
        confirm = getpass.getpass("Type it again: ")
        if password != confirm:
            raise CommandError("The two passwords do not match.")
        problem = auth.password_problem(password)
        if problem:
            raise CommandError(problem)

        auth.save_password(password, "set with manage.py dashboard_password")
        self.stdout.write(self.style.SUCCESS(f"Password saved to {location}. All signed-in devices are signed out."))