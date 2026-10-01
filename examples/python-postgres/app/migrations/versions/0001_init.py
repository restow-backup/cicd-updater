"""Notes, the audit log and the journal cursor.

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("source", sa.Text, nullable=False),
        sa.Column("event_id", sa.Text, nullable=False),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("actor", sa.Text),
        sa.Column("detail", sa.JSON),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source", "event_id"),
    )
    op.create_table(
        "updater_journal_cursor",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("last_id", sa.Text, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("updater_journal_cursor")
    op.drop_table("audit_log")
    op.drop_table("notes")
