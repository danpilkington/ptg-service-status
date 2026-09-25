-- Run in PTG-STATUS as PROGRESSIVE\administrator.
-- Adds only objects in the ptg_status schema; does not overwrite existing data.
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF SCHEMA_ID(N'ptg_status') IS NULL EXEC(N'CREATE SCHEMA ptg_status AUTHORIZATION dbo;');
IF OBJECT_ID(N'ptg_status.Documents', N'U') IS NULL
BEGIN
    CREATE TABLE ptg_status.Documents (
        Name nvarchar(20) NOT NULL CONSTRAINT PK_PtgStatusDocuments PRIMARY KEY,
        Content nvarchar(max) NOT NULL,
        Revision varchar(64) NOT NULL,
        UpdatedAt datetime2(3) NOT NULL CONSTRAINT DF_PtgStatusDocumentsUpdated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_PtgStatusDocumentsName CHECK (Name IN (N'status', N'users')),
        CONSTRAINT CK_PtgStatusDocumentsJson CHECK (ISJSON(Content) = 1)
    );
END;
IF OBJECT_ID(N'ptg_status.Users', N'V') IS NULL
EXEC(N'CREATE VIEW ptg_status.Users AS
SELECT u.Id, u.Username, u.FirstName, u.LastName, u.JobTitle, u.Role, u.Active
FROM ptg_status.Documents d
CROSS APPLY OPENJSON(d.Content) WITH (
    Id nvarchar(100) ''$.id'', Username nvarchar(100) ''$.username'',
    FirstName nvarchar(100) ''$.firstName'', LastName nvarchar(100) ''$.lastName'',
    JobTitle nvarchar(160) ''$.jobTitle'', Role nvarchar(20) ''$.role'', Active bit ''$.active''
) u WHERE d.Name = N''users'';');
IF OBJECT_ID(N'ptg_status.Services', N'V') IS NULL
EXEC(N'CREATE VIEW ptg_status.Services AS
SELECT s.Id, s.Name, s.Description, s.Status, s.ServiceGroup, s.DisplayOrder
FROM ptg_status.Documents d
CROSS APPLY OPENJSON(d.Content, ''$.services'') WITH (
    Id nvarchar(100) ''$.id'', Name nvarchar(100) ''$.name'',
    Description nvarchar(500) ''$.description'', Status nvarchar(30) ''$.status'',
    ServiceGroup nvarchar(60) ''$.group'', DisplayOrder int ''$.order''
) s WHERE d.Name = N''status'';');
COMMIT TRANSACTION;
