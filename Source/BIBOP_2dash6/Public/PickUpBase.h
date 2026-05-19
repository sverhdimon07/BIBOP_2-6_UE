// Fill out your copyright notice in the Description page of Project Settings.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "PickUpBase.generated.h"

UCLASS()
class BIBOP_2DASH6_API APickUpBase : public AActor
{
	GENERATED_BODY()

public:
	// Sets default values for this actor's properties
	APickUpBase();

	UPROPERTY(EditDefaultsOnly, BlueprintReadWrite, Category = "Mesh")
	UStaticMeshComponent* PickUpMeshComponent;

	UFUNCTION(BlueprintPure, Category = "PickUp")
	bool IsPickPpActive() const;

	UFUNCTION(BlueprintCallable, Category = "PickUp")
	void SetPickUpActive(bool state);

protected:
	// Called when the game starts or when spawned
	virtual void BeginPlay() override;

	bool bIsActive;

public:
	// Called every frame
	virtual void Tick(float DeltaTime) override;

};
