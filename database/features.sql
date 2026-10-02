-- Extend existing JSON storage without changing existing records.
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'ptg_status.Documents') AND name=N'CK_PtgStatusDocumentsName' AND definition NOT LIKE '%reviews%')
BEGIN
    ALTER TABLE ptg_status.Documents DROP CONSTRAINT CK_PtgStatusDocumentsName;
    ALTER TABLE ptg_status.Documents ADD CONSTRAINT CK_PtgStatusDocumentsName CHECK (Name IN (N'status',N'users',N'audit',N'approvals',N'availability',N'subscriptions',N'reviews'));
END;
COMMIT TRANSACTION;
