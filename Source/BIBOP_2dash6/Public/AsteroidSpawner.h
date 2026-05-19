// Fill out your copyright notice in the Description page of Project Settings.

#pragma once

#include "CoreMinimal.h"
#include "PickUpBase.h"
#include "GameFramework/Actor.h"
#include "Components/BoxComponent.h"
#include "AsteroidSpawner.generated.h"

UCLASS()
class BIBOP_2DASH6_API AAsteroidSpawner : public AActor
{
	GENERATED_BODY()
	
public:
	// Sets default values for this actor's properties
	AAsteroidSpawner();

	UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Spawner")
	UBoxComponent* SpawnArea;

	UPROPERTY(EditAnywhere, Category = "Spawner")
	TSubclassOf<APickUpBase> ActorToSpawn;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spawner")
	float MinSpawnDelay;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Spawner")
	float MaxSpawnDelay;

	FTimerHandle SpawnTimerHandle;

protected:
	// Called when the game starts or when spawned
	virtual void BeginPlay() override;

	UFUNCTION(BlueprintPure, Category = "Spawner")
	FVector GetRandomSpawnPoint();

public:
	// Called every frame
	virtual void Tick(float DeltaTime) override;

private:
	void SpawnActors();

	void StartSpawnTimer();

};
