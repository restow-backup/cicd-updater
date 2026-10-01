"""Alembic environment: the database URL comes from DATABASE_URL."""

import os

from alembic import context
from sqlalchemy import create_engine

engine = create_engine(os.environ["DATABASE_URL"])

with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()
