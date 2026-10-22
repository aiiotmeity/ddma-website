import getpass

from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Create the password hash for the dashboard login (ARG_LOGIN_PASSWORD_HASH)."

    def handle(self, *args, **options):
        password = getpass.getpass("New dashboard password: ")
        confirm = getpass.getpass("Type it again: ")

        if password != confirm:
            raise CommandError("The two passwords do not match.")
        if len(password) < 10:
            raise CommandError("Use at least 10 characters.")

        password_hash = make_password(password)
        self.stdout.write("")
        self.stdout.write("Add this to Render > Environment (and to backend/.env for local use):")
        self.stdout.write("")
        self.stdout.write(f"ARG_LOGIN_PASSWORD_HASH={password_hash}")
        self.stdout.write("")
        self.stdout.write("In backend/.env, wrap the value in single quotes:")
        self.stdout.write(f"ARG_LOGIN_PASSWORD_HASH='{password_hash}'")
